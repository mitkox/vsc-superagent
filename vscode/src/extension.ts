import { createHash } from "node:crypto";
import { devNull } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import type { ReportState, Ticket } from "../../src/core/index.ts";
import { latestAssignment, ticketStage } from "../../src/core/index.ts";
import { TicketRuntime } from "./runtime.ts";
import type {
  GitHubReviewCursor,
  GitHubSourceConfig,
  InboxItem,
  TeamsBatchCursor,
  TeamsSourceConfig,
} from "./sources.ts";
import {
  githubRepositoryRef,
  pollGitHub,
  pollGitHubReviewsBatch,
  pollTeamsBatch,
  readPullRequest,
  SourceError,
} from "./sources.ts";
import { resolveGit, Worktrees } from "./worktree.ts";
import { activateAutomation, type AutomationLifecycle } from "./automation-host.ts";

class OperatorError extends Error {}
interface Host {
  runtime: TicketRuntime;
  trees: Worktrees;
  root: string;
  identity: string;
}
interface ReportInput {
  state: ReportState;
  summary: string;
  question?: string;
  pullRequest?: number;
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const plain = (value: string) =>
  value
    .replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, " ")
    .slice(0, 300);
const safeMessage = (error: unknown) =>
  error instanceof OperatorError || error instanceof SourceError
    ? error.message
    : "Operation failed. Check source permissions, local storage and repository access. No credentials or remote response bodies were logged.";
// Values Copilot itself writes into the shared extension host env to switch exporting off.
const inertEnv = (key: string, value: string) =>
  (key === "OTEL_SDK_DISABLED" && /^true$/i.test(value)) ||
  (key === "COPILOT_OTEL_FILE_EXPORTER_PATH" && value === devNull) ||
  (/^(COPILOT_OTEL_ENABLED|COPILOT_OTEL_CAPTURE_IDENTITY|OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT)$/.test(
    key,
  ) &&
    /^(false|0)$/i.test(value));

/** Names (never values) of settings and environment variables that enable telemetry export or debug file logging. */
function exporterFindings(): string[] {
  const copilot = vscode.workspace.getConfiguration("github.copilot.chat");
  const agentHost = vscode.workspace.getConfiguration("chat.agentHost");
  const enabled = (config: vscode.WorkspaceConfiguration, key: string) =>
    key.endsWith("outfile") ? !!config.get(key) : config.get(key) === true;
  // Copilot can enable debug file logging by experiment, which getConfiguration cannot see; require an explicit opt-out.
  const debugLog = "agentDebugLog.fileLogging.enabled",
    debugLogInspect = copilot.inspect(debugLog);
  const debugLogOptedOut =
    copilot.get(debugLog) === false &&
    !!debugLogInspect &&
    [
      "policyValue",
      "workspaceFolderLanguageValue",
      "workspaceFolderValue",
      "workspaceLanguageValue",
      "workspaceValue",
      "globalLanguageValue",
      "globalValue",
    ].some((scope) => (debugLogInspect as Record<string, unknown>)[scope] !== undefined);
  return [
    ...[
      "otel.enabled",
      "otel.dbSpanExporter.enabled",
      "otel.outfile",
      "chatDebug.fileLogging.enabled",
    ]
      .filter((key) => enabled(copilot, key))
      .map((key) => `github.copilot.chat.${key}`),
    ...(debugLogOptedOut ? [] : [`github.copilot.chat.${debugLog}`]),
    ...["otel.enabled", "otel.dbSpanExporter.enabled", "otel.outfile"]
      .filter((key) => enabled(agentHost, key))
      .map((key) => `chat.agentHost.${key}`),
    ...Object.entries(process.env)
      .filter(
        ([key, value]) =>
          !!value &&
          (key.startsWith("COPILOT_OTEL_") || key.startsWith("OTEL_")) &&
          !inertEnv(key, value),
      )
      .map(([key]) => `env ${key}`),
  ];
}

/** Native extension tools never invoke a model, telemetry client, arbitrary shell, or external write API. */
export function activate(context: vscode.ExtensionContext): void {
  let current: Host | undefined;
  let initializing: Promise<Host> | undefined;
  let busy = false;
  let disposed = false;
  let openingFolder = false;
  let automation: AutomationLifecycle | undefined;
  const changed = new vscode.EventEmitter<void>();
  const abort = new AbortController();
  const exportersAtStartup = exporterFindings();
  context.subscriptions.push(changed, {
    dispose() {
      disposed = true;
      abort.abort();
      const runtime = current?.runtime;
      if (automation?.active) void automation.shutdown().finally(() => runtime?.dispose()).catch(() => {});
      else runtime?.dispose();
    },
  });

  function guard(): string {
    if (disposed || abort.signal.aborted)
      throw new OperatorError("Superagent is shutting down.");
    if (openingFolder)
      throw new OperatorError(
        "The ticket worktree is opening. Wait for the window to reload.",
      );
    if (!vscode.workspace.isTrusted)
      throw new OperatorError("Superagent requires a trusted workspace.");
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length !== 1 || folders[0]!.uri.scheme !== "file")
      throw new OperatorError(
        "Open exactly one local repository folder. Virtual and multi-root workspaces are disabled.",
      );
    if (
      vscode.workspace.getConfiguration("telemetry").get("telemetryLevel") !==
        "off" ||
      vscode.env.isTelemetryEnabled
    ) {
      throw new OperatorError(
        "Disable VS Code telemetry before using Superagent. Run Superagent: Apply Local Privacy Settings, then reload if needed.",
      );
    }
    const now = exporterFindings();
    const findings = [
      ...now,
      ...exportersAtStartup
        .filter((name) => !now.includes(name))
        .map((name) => `${name} (until reload)`),
    ];
    if (findings.length)
      throw new OperatorError(
        `Disable Copilot OpenTelemetry/debug logging and remove telemetry exporter environment variables, then reload VS Code before using Superagent. Active: ${findings.join(", ")}.`,
      );
    return folders[0]!.uri.fsPath;
  }

  async function host(): Promise<Host> {
    const root = guard();
    if (current) {
      if (current.root !== root)
        throw new OperatorError(
          "Workspace changed. Reload the window before continuing.",
        );
      return current;
    }
    if (!initializing)
      initializing = (async () => {
        const extension = vscode.extensions.getExtension<{
          getAPI(version: number): { git: { path: string } };
        }>("vscode.git");
        if (!extension)
          throw new OperatorError(
            "The built-in VS Code Git extension is required.",
          );
        const api = extension.isActive
          ? extension.exports
          : await extension.activate();
        guard();
        const git = resolveGit(api.getAPI(1).git.path);
        const probe = new Worktrees(git, root, context.globalStorageUri.fsPath);
        const common = await probe.commonDirectory();
        if (guard() !== root)
          throw new OperatorError("Workspace changed during initialization.");
        const identity = hash(common);
        const storage = join(
          context.globalStorageUri.fsPath,
          "workspaces",
          identity,
        );
        const runtime = new TicketRuntime(join(storage, "state"));
        current = {
          runtime,
          root,
          identity,
          trees: new Worktrees(git, root, join(storage, "worktrees")),
        };
        return current;
      })().finally(() => {
        initializing = undefined;
      });
    return initializing;
  }

  async function confirm(message: string, detail: string): Promise<boolean> {
    const answer = await vscode.window.showWarningMessage(
      message,
      { modal: true, detail },
      "Approve",
    );
    guard();
    return answer === "Approve";
  }

  async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    guard();
    if (busy)
      throw new OperatorError(
        "Another Superagent operation is active. Complete or cancel it first.",
      );
    busy = true;
    try {
      return await work();
    } finally {
      busy = false;
      changed.fire();
    }
  }

  function register(name: string, work: () => Promise<unknown>): void {
    context.subscriptions.push(
      vscode.commands.registerCommand(`superagent.${name}`, () =>
        exclusive(work).catch((error) =>
          vscode.window.showErrorMessage(safeMessage(error)),
        ),
      ),
    );
  }

  async function choose(
    runtime: TicketRuntime,
    predicate: (ticket: Ticket) => boolean = () => true,
  ): Promise<Ticket | undefined> {
    const picked = await vscode.window.showQuickPick(
      runtime
        .list()
        .filter(predicate)
        .map((ticket) => ({
          label: plain(ticket.title),
          description: `${ticket.id.slice(0, 8)} · ${ticketStage(ticket).stage}`,
          ticket,
        })),
      { title: "Superagent tickets", placeHolder: "Choose an approved ticket" },
    );
    guard();
    return picked?.ticket;
  }

  async function active(h: Host): Promise<Ticket> {
    const id = await h.trees.ticketAt(guard());
    guard();
    if (!id)
      throw new OperatorError(
        "Open an approved ticket worktree with Superagent: Review / Continue Ticket before using this tool.",
      );
    return h.runtime.get(id);
  }

  const provider: vscode.TreeDataProvider<Ticket> = {
    onDidChangeTreeData: changed.event,
    getTreeItem(ticket) {
      const item = new vscode.TreeItem(plain(ticket.title));
      item.description = `${ticketStage(ticket).stage} · ${latestAssignment(ticket)?.report?.state ?? "queued"}`;
      item.tooltip = `${ticket.id}\n${plain(latestAssignment(ticket)?.report?.summary ?? "Waiting for local worktree preparation")}`;
      item.command = { command: "superagent.open", title: "Review / Continue" };
      return item;
    },
    async getChildren() {
      try {
        return (await host()).runtime.list();
      } catch {
        return [];
      }
    },
  };
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("superagent.tickets", provider),
  );

  register("new", async () => {
    const h = await host();
    const text = await vscode.window.showInputBox({
      title: "New Superagent ticket",
      prompt:
        "Describe the work you authorize. No source content is sent to a model until you use Copilot.",
      ignoreFocusOut: true,
    });
    guard();
    if (!text?.trim()) return;
    if (await confirm("Create this local ticket?", text))
      h.runtime.create(text);
  });

  register("open", async () => {
    const h = await host(),
      ticket = await choose(h.runtime);
    if (!ticket) return;
    const action = await vscode.window.showQuickPick(
      [
        "Open isolated worktree",
        "Read ticket",
        "Add follow-up",
        "Refresh followed pull requests",
      ],
      { title: plain(ticket.title) },
    );
    guard();
    if (action === "Read ticket") {
      const doc = await vscode.workspace.openTextDocument({
        language: "plaintext",
        content: JSON.stringify(h.runtime.context(ticket.id), null, 2),
      });
      guard();
      await vscode.window.showTextDocument(doc);
    } else if (action === "Add follow-up") {
      const text = await vscode.window.showInputBox({
        prompt: "Authorize an in-scope follow-up",
        ignoreFocusOut: true,
      });
      guard();
      if (text && (await confirm("Add this follow-up to the ticket?", text)))
        h.runtime.followup(ticket.id, text);
    } else if (action === "Refresh followed pull requests") {
      const config = await github();
      const fingerprint = sourceFingerprint();
      if (!h.runtime.matchesPullRequestSource(ticket.id, config))
        throw new OperatorError(
          "The GitHub repository differs from this ticket’s PR binding. Restore its approved source configuration before refreshing.",
        );
      h.runtime.reconcileGitHubBindings(config);
      const namespace = githubRepositoryRef(config, 1).source;
      for (const followed of h.runtime.get(ticket.id).follows ?? []) {
        if (!followed.thread.startsWith(`${namespace}:`)) continue;
        const number = Number(followed.thread.slice(namespace.length + 1));
        if (!Number.isSafeInteger(number) || number < 1) continue;
        const pr = await readPullRequest(config, number, abort.signal);
        verifySources(fingerprint);
        if (pr.state === "closed")
          h.runtime.closePullRequest(number, pr.merged ? "merged" : "closed", config);
      }
    } else if (action === "Open isolated worktree") {
      if (ticket.ended)
        throw new OperatorError(
          "This ticket has ended. Add an approved follow-up or create a new ticket.",
        );
      if (h.runtime.paused)
        throw new OperatorError(
          "Resume Superagent intake before starting work.",
        );
      if (
        !(await confirm(
          "Prepare and open this ticket worktree?",
          `Creates a local branch from committed HEAD and opens it in this window. Existing changes stay in their checkout.\nTicket: ${plain(ticket.title)}`,
        ))
      )
        return;
      const directory = await h.trees.prepare(ticket.id, abort.signal);
      guard();
      if (automation?.active) {
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(directory), { forceNewWindow: true });
        return;
      }
      // The new window host takes the same common-repository lock after this one releases it.
      openingFolder = true;
      h.runtime.dispose();
      current = undefined;
      try {
        await vscode.commands.executeCommand(
          "vscode.openFolder",
          vscode.Uri.file(directory),
          false,
        );
      } catch {
        openingFolder = false;
        throw new OperatorError(
          "Could not open the ticket worktree. No work was started; retry Review / Continue Ticket.",
        );
      }
    }
  });

  register("pause", async () => {
    const h = await host();
    if (
      await confirm(
        h.runtime.paused
          ? "Resume Superagent intake?"
          : "Pause Superagent intake?",
        "Pausing stops new ticket starts and follow-ups. It does not cancel Copilot tools already running; use Stop in Copilot Chat to cancel them.",
      )
    )
      h.runtime.setPaused(!h.runtime.paused);
  });
  register("stop", async () => {
    const h = await host(),
      ticket = await choose(h.runtime, (ticket) => !ticket.ended);
    if (
      ticket &&
      (await confirm(
        "Revoke this ticket’s authorization?",
        "Stops future Superagent work. Also press Stop in Copilot Chat to cancel any native tools already running. Worktrees are retained for review.",
      ))
    )
      h.runtime.stop(ticket.id);
  });
  register("retry", async () => {
    const h = await host(),
      ticket = await choose(
        h.runtime,
        (ticket) =>
          !ticket.ended &&
          ["blocked", "failed"].includes(
            latestAssignment(ticket)?.report?.state ?? "",
          ),
      );
    if (
      ticket &&
      (await confirm(
        "Retry this blocked ticket?",
        "Inspect its worktree and current external state first. Retrying does not authorize repeating a publish, merge, deployment or other external write.",
      ))
    )
      h.runtime.retry(ticket.id);
  });

  function settings() {
    return vscode.workspace.getConfiguration("superagent");
  }
  function sourceFingerprint(): string {
    const c = settings();
    return hash(
      JSON.stringify(
        [
          "github.origin",
          "github.repository",
          "github.account",
          "github.allowedActors",
          "teams.tenantId",
          "teams.chatIds",
          "teams.channels",
          "teams.allowedActors",
        ].map((key) => c.get(key)),
      ),
    );
  }
  function verifySources(expected: string): void {
    guard();
    if (sourceFingerprint() !== expected)
      throw new OperatorError(
        "Source configuration changed. Run inbox check again to approve the new scope.",
      );
  }
  function githubKey(): string {
    return `github:${hash(JSON.stringify([settings().get("github.origin"), settings().get("github.repository")]))}`;
  }
  async function github(): Promise<GitHubSourceConfig> {
    const c = settings(),
      fingerprint = sourceFingerprint();
    const token = await context.secrets.get(githubKey());
    verifySources(fingerprint);
    if (!token)
      throw new OperatorError(
        "Configure a GitHub read credential for this exact origin/repository with Superagent: Configure Source Credential.",
      );
    return {
      origin: c.get("github.origin", "https://api.github.com"),
      repository: c.get("github.repository", ""),
      account: c.get("github.account", ""),
      allowedActors: c.get("github.allowedActors", []),
      token,
    };
  }

  register("secrets", async () => {
    const fingerprint = sourceFingerprint(),
      key = githubKey();
    const token = await vscode.window.showInputBox({
      title: "GitHub source read credential",
      prompt:
        "Fine-grained token: repository Issues, Pull requests and Metadata read only. Leave empty to remove. Teams uses Microsoft sign-in.",
      password: true,
      ignoreFocusOut: true,
    });
    verifySources(fingerprint);
    if (token === undefined) return;
    if (
      !(await confirm(
        "Update this source credential?",
        `Credential is stored in VS Code SecretStorage and bound to ${plain(settings().get("github.origin", ""))} / ${plain(settings().get("github.repository", ""))}.`,
      ))
    )
      return;
    verifySources(fingerprint);
    if (token) await context.secrets.store(key, token);
    else await context.secrets.delete(key);
  });

  register("poll", async () => {
    const h = await host();
    if (h.runtime.paused)
      throw new OperatorError("Superagent intake is paused.");
    const c = settings(),
      fingerprint = sourceFingerprint();
    if (
      !(await confirm(
        "Read the configured GitHub and Teams inboxes?",
        "Only configured repositories, chats/channels, and allowed senders are considered. Every candidate requires a separate local decision. No replies are sent. GitHub reviews include older PR history; other sources start with a 24-hour lookback.",
      ))
    )
      return;
    verifySources(fingerprint);
    const cursorKey = `inbox:${h.identity}:${fingerprint}`;
    type Cursor = TeamsBatchCursor | GitHubReviewCursor;
    type Progress = { since: string; startedAt: string; cursor?: Cursor };
    type Source = {
      key: string;
      read(
        since: string,
        cursor?: Cursor,
      ): Promise<{ items: InboxItem[]; next?: Cursor }>;
    };
    const sources: Source[] = [];
    if (c.get<string>("github.repository")) {
      sources.push({
        key: "github",
        read: async (since) => ({
          items: await pollGitHub({ ...(await github()), since }, abort.signal),
        }),
      });
      sources.push({
        key: "github-reviews",
        read: async (since, cursor) =>
          pollGitHubReviewsBatch(
            { ...(await github()), since },
            cursor as GitHubReviewCursor | undefined,
            abort.signal,
          ),
      });
    }
    if (c.get<string>("teams.tenantId")) {
      const tenantId = c.get<string>("teams.tenantId", "");
      const chatIds = c.get<string[]>("teams.chatIds", []);
      const channels = c.get<TeamsSourceConfig["channels"]>(
        "teams.channels",
        [],
      );
      const scopes = [
        `VSCODE_TENANT:${tenantId}`,
        ...(chatIds.length ? ["https://graph.microsoft.com/Chat.Read"] : []),
        ...(channels.length
          ? ["https://graph.microsoft.com/ChannelMessage.Read.All"]
          : []),
      ];
      const readTeams = async (
        chats: string[],
        selectedChannels: TeamsSourceConfig["channels"],
        since: string,
        cursor?: TeamsBatchCursor,
      ) => {
        if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(tenantId))
          throw new OperatorError(
            "Configure a valid Entra tenant UUID for Teams.",
          );
        const session = await vscode.authentication.getSession(
          "microsoft",
          scopes,
          { createIfNone: true },
        );
        verifySources(fingerprint);
        return pollTeamsBatch(
          {
            tenantId,
            chatIds: chats,
            channels: selectedChannels,
            allowedActors: c.get("teams.allowedActors", []),
            token: session.accessToken,
            since,
          },
          cursor,
          abort.signal,
          async (input, init) => {
            verifySources(fingerprint);
            abort.signal.throwIfAborted();
            const response = await fetch(input, init);
            verifySources(fingerprint);
            abort.signal.throwIfAborted();
            return response;
          },
        );
      };
      for (const chat of [...new Set(chatIds)])
        sources.push({
          key: `chat:${chat}`,
          read: (since, cursor) =>
            readTeams(
              [chat],
              [],
              since,
              cursor as TeamsBatchCursor | undefined,
            ),
        });
      for (const channel of channels)
        sources.push({
          key: `channel:${channel.teamId}:${channel.channelId}`,
          read: (since, cursor) =>
            readTeams(
              [],
              [channel],
              since,
              cursor as TeamsBatchCursor | undefined,
            ),
        });
      if (!chatIds.length && !channels.length)
        sources.push({
          key: "teams",
          read: async () => {
            throw new OperatorError(
              "Configure at least one approved Teams chat or channel.",
            );
          },
        });
    }
    let found = false,
      incomplete = false;
    const errors: string[] = [];
    for (const source of sources) {
      verifySources(fingerprint);
      const sourceKey = `${cursorKey}:source:${hash(source.key)}`;
      const progressKey = `${sourceKey}:progress`;
      const prior = context.globalState.get<Progress>(progressKey);
      const progress: Progress = prior ?? {
        since:
          context.globalState.get<string>(sourceKey) ??
          context.globalState.get<string>(cursorKey) ??
          new Date(Date.now() - 86400_000).toISOString(),
        startedAt: new Date(Date.now() - 2000).toISOString(),
      };
      let batch: { items: InboxItem[]; next?: Cursor };
      try {
        batch = await source.read(progress.since, progress.cursor);
      } catch (error) {
        verifySources(fingerprint);
        if (
          error instanceof SourceError &&
          [
            "Source page changed; restart the channel scan",
            "GitHub review scan changed; restart the scan",
          ].includes(error.message) &&
          prior
        ) {
          await context.globalState.update(progressKey, {
            since: prior.since,
            startedAt: prior.startedAt,
          });
        }
        errors.push(`${plain(source.key)}: ${safeMessage(error)}`);
        continue;
      }
      let decided = true;
      for (const item of batch.items) {
        const receipt = `${cursorKey}:${item.id}`;
        if (context.globalState.get<boolean>(receipt)) continue;
        found = true;
        const doc = await vscode.workspace.openTextDocument({
          language: "plaintext",
          content: `UNTRUSTED ${item.source.toUpperCase()} MESSAGE\nSender: ${item.actor}\nThread: ${item.thread}\n\n${item.text}`,
        });
        await vscode.window.showTextDocument(doc);
        verifySources(fingerprint);
        const action = await vscode.window.showQuickPick(
          [
            "Approve new ticket",
            "Approve follow-up to a ticket",
            "Dismiss",
            "Decide later",
          ],
          {
            title: `Untrusted ${item.source} message from ${plain(item.actor)}`,
            placeHolder: plain(item.text),
          },
        );
        verifySources(fingerprint);
        if (!action || action === "Decide later") {
          decided = false;
          break;
        }
        if (action === "Approve new ticket")
          h.runtime.create(item.text, {
            source: item.source,
            id: item.id,
            actor: item.actor,
            context: item.context,
            url: item.url,
            thread: item.thread,
          });
        else if (action === "Approve follow-up to a ticket") {
          const ticket = await choose(h.runtime, (ticket) => !ticket.ended);
          if (!ticket) {
            decided = false;
            break;
          }
          verifySources(fingerprint);
          if (
            !(await confirm(
              "Authorize this external follow-up?",
              `Ticket: ${plain(ticket.title)}\nSender: ${plain(item.actor)}\n${plain(item.text)}`,
            ))
          ) {
            decided = false;
            break;
          }
          verifySources(fingerprint);
          h.runtime.followup(ticket.id, item.text, {
            source: item.source,
            id: item.id,
            actor: item.actor,
            context: item.context,
            url: item.url,
            thread: item.thread,
          });
        }
        await context.globalState.update(receipt, true);
      }
      if (!decided) {
        incomplete = true;
        continue;
      }
      verifySources(fingerprint);
      if (batch.next) {
        await context.globalState.update(progressKey, {
          ...progress,
          cursor: batch.next,
        });
        incomplete = true;
      } else {
        await context.globalState.update(sourceKey, progress.startedAt);
        if (prior) await context.globalState.update(progressKey, undefined);
      }
    }
    if (errors.length)
      await vscode.window.showErrorMessage(
        `Some inbox sources failed: ${errors.join("; ")}`,
      );
    if (incomplete)
      await vscode.window.showInformationMessage(
        "Some inbox sources have more work. Run the inbox check again to continue.",
      );
    else if (!found && !errors.length)
      await vscode.window.showInformationMessage(
        "No new authorized inbox candidates found in the bounded source scan.",
      );
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("superagent.privacy", async () => {
      const answer = await vscode.window.showWarningMessage(
        "Apply user-level VS Code privacy settings?",
        {
          modal: true,
          detail:
            "Disables VS Code telemetry/feedback, Copilot and Agent Host OpenTelemetry export/content capture, and Copilot debug file logging. Remove exporter environment variables and reload afterward. Provider operational logging and other extensions remain governed separately.",
        },
        "Apply",
      );
      if (answer !== "Apply") return;
      await vscode.workspace
        .getConfiguration("telemetry")
        .update("telemetryLevel", "off", vscode.ConfigurationTarget.Global);
      await vscode.workspace
        .getConfiguration("telemetry")
        .update("feedback.enabled", false, vscode.ConfigurationTarget.Global);
      const copilot = vscode.workspace.getConfiguration("github.copilot.chat");
      for (const key of [
        "otel.enabled",
        "otel.dbSpanExporter.enabled",
        "otel.captureContent",
        "otel.captureIdentity",
        "agentDebugLog.fileLogging.enabled",
      ])
        await copilot.update(key, false, vscode.ConfigurationTarget.Global);
      await copilot.update(
        "otel.outfile",
        "",
        vscode.ConfigurationTarget.Global,
      );
      const agentHost = vscode.workspace.getConfiguration("chat.agentHost");
      for (const key of [
        "otel.enabled",
        "otel.dbSpanExporter.enabled",
        "otel.captureContent",
      ])
        await agentHost.update(key, false, vscode.ConfigurationTarget.Global);
      await agentHost.update(
        "otel.outfile",
        "",
        vscode.ConfigurationTarget.Global,
      );
      await vscode.window.showInformationMessage(
        "Privacy settings applied. Remove telemetry exporter environment variables and reload VS Code before using Superagent.",
      );
    }),
  );

  context.subscriptions.push(
    vscode.lm.registerTool<Record<string, never>>("superagent_snapshot", {
      async invoke(_options, token) {
        try {
          return await exclusive(async () => {
            if (token.isCancellationRequested)
              throw new OperatorError("Request cancelled.");
            const h = await host(),
              ticket = await active(h);
            if (
              h.runtime.paused ||
              ticket.ended ||
              ["blocked", "failed"].includes(
                latestAssignment(ticket)?.report?.state ?? "",
              )
            )
              throw new OperatorError(
                "Ticket is paused, blocked or ended. A person must resume or retry it before continuing.",
              );
            if (token.isCancellationRequested)
              throw new OperatorError("Request cancelled.");
            if (
              latestAssignment(ticket)?.state === "pending" ||
              ["waiting", "ready"].includes(
                latestAssignment(ticket)?.report?.state ?? "",
              ) ||
              ticket.undelivered.length
            ) {
              if (
                !(await confirm(
                  "Start or continue this ticket in Copilot?",
                  `Ticket: ${plain(ticket.title)}\nIts approved request and follow-ups will be supplied to the selected Copilot model.`,
                ))
              )
                throw new OperatorError("Work was not started.");
              if (token.isCancellationRequested)
                throw new OperatorError("Request cancelled.");
              await active(h);
              guard();
              h.runtime.begin(ticket.id);
            }
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                JSON.stringify({
                  untrustedContent: true,
                  ...h.runtime.context(ticket.id),
                }),
              ),
            ]);
          });
        } catch (error) {
          throw new Error(safeMessage(error));
        }
      },
    }),
  );
  context.subscriptions.push(
    vscode.lm.registerTool<ReportInput>("superagent_report", {
      prepareInvocation() {
        return {
          invocationMessage: "Record ticket report",
          confirmationMessages: {
            title: "Record Superagent ticket report?",
            message:
              "This updates local ticket state. An additional native confirmation shows the exact report. No external message is sent.",
          },
        };
      },
      async invoke(options, token) {
        try {
          return await exclusive(async () => {
            const h = await host(),
              ticket = await active(h),
              input = options.input;
            if (token.isCancellationRequested)
              throw new OperatorError("Request cancelled.");
            if (
              ![
                "progress",
                "waiting",
                "ready",
                "blocked",
                "failed",
                "dropped",
              ].includes(input.state) ||
              typeof input.summary !== "string" ||
              input.summary.length > 10_000 ||
              !input.summary.trim() ||
              (input.question !== undefined &&
                (typeof input.question !== "string" ||
                  input.question.length > 4000)) ||
              (input.pullRequest !== undefined &&
                (!Number.isSafeInteger(input.pullRequest) ||
                  input.pullRequest < 1))
            )
              throw new OperatorError("Invalid report input.");
            const binding = githubKey();
            if (
              !(await confirm(
                `Record ${input.state} report for ${plain(ticket.title)}?`,
                `${input.summary}${input.question ? `\nQuestion: ${input.question}` : ""}${input.pullRequest ? `\nFollow PR #${input.pullRequest} in ${plain(settings().get("github.repository", ""))}` : ""}`,
              ))
            )
              throw new OperatorError("Report declined.");
            if (token.isCancellationRequested)
              throw new OperatorError("Request cancelled.");
            await active(h);
            guard();
            if (input.pullRequest !== undefined) {
              if (
                !settings().get<string>("github.repository") ||
                binding !== githubKey()
              )
                throw new OperatorError(
                  "A stable GitHub repository configuration is required to bind a PR.",
                );
              if (!h.runtime.matchesPullRequestSource(ticket.id, {
                origin: settings().get("github.origin", "https://api.github.com"),
                repository: settings().get("github.repository", ""),
              }))
                throw new OperatorError(
                  "This ticket already follows PRs in another GitHub source.",
                );
            }
            const updated =
              input.pullRequest === undefined
                ? h.runtime.report(
                    ticket.id,
                    input.state,
                    input.summary,
                    input.question,
                  )
                : h.runtime.reportWithPullRequest(
                    ticket.id,
                    input.state,
                    input.summary,
                    input.question,
                    input.pullRequest,
                    { origin: settings().get("github.origin", "https://api.github.com"), repository: settings().get("github.repository", "") },
                  );
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(JSON.stringify(updated)),
            ]);
          });
        } catch (error) {
          throw new Error(safeMessage(error));
        }
      },
    }),
  );
  automation = activateAutomation(context, { host, guard, github, changed: () => changed.fire() });
}
