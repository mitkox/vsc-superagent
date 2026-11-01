# Superagent for Copilot

A native VS Code extension that brings an approval-based ticket engine to GitHub Copilot. Select **Superagent** in Copilot's agents dropdown. It manages approved tasks, isolated worktrees, follow-ups, progress, questions, retries, pause/stop, and pull-request completion. GitHub and Microsoft Teams provide read-only inbox candidates.

This is an adaptation with enterprise safety controls. Production deployment requires the acceptance steps in [SECURITY.md](SECURITY.md). Native discovery, activation, agent contribution and tool registration were smoke-tested in an isolated VS Code Insiders 1.145 profile. Copilot model execution and Microsoft tenant access still require live qualification.

## Build and install

Requirements: VS Code **1.144+**, Git, a Copilot subscription permitted by your organization, Node **22.19+**, and npm. The version floor follows the stable API definitions used to build this package. No proposed API is required.

From `vscode/`:

```sh
npm ci --ignore-scripts
npm run package
code --install-extension dist/vsc-superagent.vsix
```

`npm run check` typechecks the extension and shared core, runs behavioral/security tests, bundles the extension, and checks the package's security properties. `npm run audit:production` audits shipped npm dependencies; the extension currently has none. The VSIX includes only the bundled extension, agent definition, license and documentation. Its bundle has a SHA-256 file for artifact verification. The publisher ID `superagent-local` is a local packaging identity, not a verified Marketplace publisher.

## Local workflow

1. Open one trusted local Git repository. Remote extension hosts with a local filesystem may work but need separate qualification. Virtual and multi-root workspaces are disabled.
2. Run **Superagent: Apply Local Privacy Settings**. It explicitly offers to disable VS Code telemetry plus Copilot/Agent Host OpenTelemetry and debug file logging. Remove any `COPILOT_OTEL_*` or `OTEL_*` exporter environment overrides and reload. Superagent blocks its work tools while those known telemetry mechanisms are enabled.
3. Run **Superagent: New Ticket** and approve the concrete request.
4. Run **Superagent: Review / Continue Ticket**, choose the ticket, then **Open isolated worktree**. The extension creates a branch from the primary checkout's committed HEAD and opens the worktree in the same window. Dirty source files stay in the primary checkout.
5. Select **Superagent** in Copilot Chat and ask it to work on the approved ticket. Its ticket tool requests local consent before providing task content to the selected model. Review native edit and terminal approvals normally.
6. The report tool asks for independent native confirmation of the report. Reports can request human input or review. Pushes, PR creation, comments, merges and deployments require separate authorization through your normal tools.
7. Include a PR number in an approved report to bind it to the configured GitHub repository. **Refresh followed pull requests** reads actual PR state before recording a merge/close. An unbound ready ticket completes locally; that does not prove code review, CI, merging, deployment or production acceptance.

Use the Explorer's **Superagent Tickets** view for status. **Pause / Resume Intake**, **Stop Ticket** and **Retry Blocked Ticket** are native commands. Stop revokes future ticket access; use Copilot Chat's Stop control to cancel tools already executing. Crash recovery marks interrupted work blocked and requires an explicit retry. One ticket may actively work at a time; waiting/blocked tickets do not occupy that slot.

## GitHub inbox

Configure these at user or managed application scope. Repository settings cannot set security-sensitive source configuration:

```json
{
  "superagent.github.origin": "https://api.github.com",
  "superagent.github.repository": "your-org/your-repo",
  "superagent.github.account": "your-agent-account",
  "superagent.github.allowedActors": ["approved-requester"]
}
```

For GitHub Enterprise Server, set the explicitly approved HTTPS API base, such as `https://github.example.com/api/v3`. Run **Superagent: Configure Source Credential** to enter a fine-grained token limited to that repository with Issues, Pull requests and Metadata read permissions. Credentials are held in VS Code SecretStorage and bound to the exact origin and repository. Re-enter credentials after changing either. Do not put tokens in settings or repository files.

**Check GitHub / Teams Inbox** reads issue/PR bodies, issue comments, review comments and review bodies from allowed human senders that explicitly mention the configured account. The first issue and comment scan looks back 24 hours. Review discovery separately cycles through all open and closed PRs and their reviews, regardless of the PR's last update or the review's submission time, because the review-list API does not provide a reliable body-edit cursor. The first review cycle can therefore surface old requests. Later cycles detect changed review bodies by their content identity; unchanged decisions deduplicate across restarts. A candidate can start a ticket or be explicitly attached as a follow-up. Provider content never changes settings or starts execution by itself.

## Microsoft Teams inbox

Configure your Entra tenant UUID, specific chat IDs and/or team/channel pairs, and allowed sender **Entra object UUIDs**, not display names:

```json
{
  "superagent.teams.tenantId": "11111111-1111-1111-1111-111111111111",
  "superagent.teams.chatIds": ["19:your-chat-id@thread.v2"],
  "superagent.teams.channels": [
    { "teamId": "22222222-2222-2222-2222-222222222222", "channelId": "19:your-channel-id@thread.tacv2" }
  ],
  "superagent.teams.allowedActors": ["33333333-3333-3333-3333-333333333333"]
}
```

Run **Check GitHub / Teams Inbox** and complete Microsoft sign-in through VS Code's built-in Microsoft authentication provider. The request pins the configured tenant using `VSCODE_TENANT:<tenant-id>`. Only configured sources are queried. Chat sources request delegated `Chat.Read`; channel sources request delegated `ChannelMessage.Read.All`. Channel access may require administrator consent. Your administrator must approve the VS Code authentication application's access under your tenant's policies. No app secret, bot registration, webhook receiver, service account, send permission, or Teams token pasted into this extension is required.

The extension reads only `https://graph.microsoft.com/v1.0`, including channel replies. It strips Teams HTML to plain text, rejects bot/application/system/deleted messages, and checks sender object IDs. Every allowed sender's message in a configured scope is a candidate; use dedicated intake chats/channels. It never posts, replies, reacts or marks messages read. Sovereign Microsoft clouds are not supported by this fixed-origin build.

## Bounds and retained data

All polling is explicit and foreground: nothing watches while the editor is closed or runs on activation. A request times out after 10 seconds and accepts at most 1 MiB. GitHub review discovery scans at most one 25-PR page and 25 review pages per inbox check; it saves progress only after the batch is decided. Run the inbox check again when prompted to complete the cycle. Reviews edited after their PR was scanned appear on a later cycle; large histories may therefore take many checks and API requests. Review or PR pagination changes at a checkpoint restart the cycle without advancing it. Other GitHub lists and Teams chat and reply lists are limited to five pages. A Teams channel scan handles at most 25 roots per invocation and continues on subsequent inbox checks, retaining its lookback until the whole scan completes. If a partially processed page changes order, the channel scan restarts without advancing its cursor. Each source advances independently after its candidates are decided, so a failing source does not block the others. Teams chats stop at older history under Graph's explicit modification-date ordering. A single channel root with more than five pages of replies still exceeds the scan bound; large or frequently changing histories require a separately designed ingestion service. Pagination across requests depends on provider continuation behavior and has not been qualified against live services.

Teams message identities now use the edit timestamp rather than the modification timestamp, so reactions do not create new candidates. Existing installations may see a one-time reappearance of an older message because receipts created with the previous identity format are not interchangeable; every candidate still requires local approval.

Private local state is namespaced by the canonical Git common directory under the extension's global storage. Tickets include approved task/follow-up text and its provenance. Files use `0600`, directories `0700` on POSIX. Worktrees and branches are retained; the extension does not delete or reset them. Inbox decision receipts and cursors use VS Code's local global state and are not registered for Settings Sync. The last 2,000 metadata audit entries are retained. State is capped at 16 MiB and fails closed at capacity. These records are local operational data, not telemetry or an immutable compliance audit.

After a crash, a stale `state.lock` intentionally prevents concurrent writers. Verify the previous extension host has stopped before removing only that lock in the relevant storage directory. Preserve `state.json`; corruption or incompatible versions fail closed. Back up state and worktrees together. Windows relies on OS access controls; file mode bits do not establish an ACL boundary there.

VS Code/Copilot/provider telemetry and service logging are separate from this extension. See [SECURITY.md](SECURITY.md) for the precise guarantees and release gates.
