import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const TICKET = /^[a-zA-Z0-9_-]{1,128}$/;

/** VS Code's Git extension reports a bare "git" when it found Git on PATH; only absolute PATH entries are searched. */
export function resolveGit(
  git: string,
  pathVariable = process.env.PATH ?? "",
): string {
  if (isAbsolute(git) || /[\\/]/.test(git)) return git;
  const suffixes = platform() === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const directory of pathVariable.split(delimiter).filter(isAbsolute))
    for (const suffix of suffixes) {
      const candidate = join(directory, git + suffix);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        /* not here */
      }
    }
  throw new Error(`Cannot find ${git} on PATH`);
}

/** Only local Git plumbing is executed; no shell, hooks, filters, submodules or network. */
export class Worktrees {
  private boundCommonDirectory?: string;

  constructor(
    private readonly git: string,
    private readonly source: string,
    private readonly storage: string,
  ) {
    if (![git, source, storage].every(isAbsolute))
      throw new Error("Git and workspace paths must be absolute");
  }

  private async command(
    args: string[],
    cwd = this.source,
    signal?: AbortSignal,
  ): Promise<string> {
    const env: NodeJS.ProcessEnv = {
      PATH: dirname(this.git),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: platform() === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_LFS_SKIP_SMUDGE: "1",
    };
    for (const key of ["SystemRoot", "SYSTEMROOT", "TEMP", "TMP"])
      if (process.env[key]) env[key] = process.env[key];
    const { stdout } = await run(
      this.git,
      [
        "-c",
        `core.hooksPath=${platform() === "win32" ? "NUL" : "/dev/null"}`,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "submodule.recurse=false",
        "-c",
        "protocol.file.allow=never",
        "-c",
        "protocol.ext.allow=never",
        ...args,
      ],
      {
        cwd,
        env,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        signal,
      },
    );
    return stdout.trim();
  }

  async commonDirectory(): Promise<string> {
    return realpath(
      await this.command([
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
    );
  }

  private async verifiedCommonDirectory(): Promise<string> {
    const current = await this.commonDirectory();
    if (this.boundCommonDirectory && current !== this.boundCommonDirectory)
      throw new Error("Source repository changed; review it before continuing");
    return current;
  }

  private async storageDirectory(): Promise<string> {
    const stat = await lstat(this.storage);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Unsafe worktree storage path");
    const root = await realpath(this.storage);
    if (root !== resolve(this.storage)) throw new Error("Unsafe worktree storage path");
    return root;
  }

  async validate(ticket: string, directory: string): Promise<string> {
    if (typeof ticket !== "string" || !TICKET.test(ticket))
      throw new Error("Invalid ticket identifier");
    if (directory !== join(this.storage, ticket))
      throw new Error("Saved worktree path does not match the ticket");
    await this.storageDirectory();
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== resolve(directory))
      throw new Error("Unsafe saved worktree path");
    if (await this.ticketAt(directory) !== ticket)
      throw new Error("Saved worktree does not match the ticket");
    return directory;
  }

  async ticketAt(path: string): Promise<string | undefined> {
    const actual = await realpath(path);
    let root: string;
    try {
      root = await this.storageDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (dirname(actual) !== root) return undefined;
    const ticket = actual.slice(root.length + 1);
    if (!TICKET.test(ticket)) return undefined;
    const marker = await lstat(join(root, `.${ticket}.ready`)).catch(
      () => undefined,
    );
    if (!marker?.isFile() || marker.isSymbolicLink())
      throw new Error(
        "Worktree preparation is incomplete; inspect it before manually recovering",
      );
    const top = await this.command(["rev-parse", "--show-toplevel"], actual);
    if ((await realpath(top)) !== actual) return undefined;
    const common = await this.command(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      actual,
    );
    const expected = await this.verifiedCommonDirectory();
    if ((await realpath(common)) !== expected)
      throw new Error("Worktree belongs to another repository");
    const branch = await this.command(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      actual,
    ).catch(() => "");
    if (branch !== `superagent/${ticket}`)
      throw new Error(
        "Worktree branch changed or is detached; review it before continuing",
      );
    this.boundCommonDirectory ??= expected;
    await this.verifiedCommonDirectory();
    return ticket;
  }

  async prepare(ticket: string, signal?: AbortSignal): Promise<string> {
    if (typeof ticket !== "string" || !TICKET.test(ticket)) throw new Error("Invalid ticket identifier");
    const common = await this.verifiedCommonDirectory();
    this.boundCommonDirectory ??= common;
    await mkdir(this.storage, { recursive: true, mode: 0o700 });
    await this.storageDirectory();
    const destination = join(this.storage, ticket);
    const branch = `superagent/${ticket}`;
    try {
      await lstat(destination);
      if ((await this.ticketAt(destination)) !== ticket)
        throw new Error("Worktree path already occupied");
      const current = await this.command(
        ["symbolic-ref", "--short", "HEAD"],
        destination,
      );
      if (current !== branch)
        throw new Error("Worktree branch changed; review it before continuing");
      return this.validate(ticket, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    // Always start at the primary checkout's committed HEAD, preserving its dirty files.
    const entries = await this.command([
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    const primary = entries
      .split("\0")
      .find((line) => line.startsWith("worktree "))
      ?.slice(9);
    if (!primary || !isAbsolute(primary))
      throw new Error("Cannot determine primary checkout");
    const head = await this.command(["rev-parse", "--verify", "HEAD"], primary);
    if (!/^[a-f0-9]{40,64}$/.test(head))
      throw new Error("Invalid repository HEAD");

    // Repo-defined smudge/process filters can execute programs even with hooks disabled.
    await this.command(
      [
        "worktree",
        "add",
        "--no-checkout",
        "-b",
        branch,
        "--",
        destination,
        head,
      ],
      primary,
      signal,
    );
    const config = await this.command(
      ["config", "--includes", "--name-only", "--get-regexp", "^filter\\."],
      destination,
    ).catch((error) => {
      if (error.code === 1) return "";
      throw error;
    });
    const filters = [
      ...new Set(
        config
          .split("\n")
          .map(
            (key) =>
              /^filter\.(.+)\.(?:clean|smudge|process|required)$/.exec(
                key,
              )?.[1],
          )
          .filter((x): x is string => !!x),
      ),
    ];
    if (filters.some((filter) => !/^[a-zA-Z0-9_.-]+$/.test(filter)))
      throw new Error("Unsupported Git filter configuration");
    const overrides = filters.flatMap((filter) => [
      "-c",
      `filter.${filter}.smudge=`,
      "-c",
      `filter.${filter}.process=`,
      "-c",
      `filter.${filter}.required=false`,
    ]);
    await this.command(
      [...overrides, "checkout", "--force", "HEAD", "--", "."],
      destination,
      signal,
    );
    await writeFile(join(this.storage, `.${ticket}.ready`), `${head}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    return this.validate(ticket, destination);
  }
}
