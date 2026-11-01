import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { resolveGit, Worktrees } from "../src/worktree.ts";

test("resolves a bare git command from absolute PATH entries only", () => {
  assert.equal(resolveGit("/usr/bin/git"), "/usr/bin/git");
  assert.equal(
    resolveGit(
      "git",
      `relative/bin:${dirname(execFileSync("which", ["git"], { encoding: "utf8" }).trim())}`,
    ),
    execFileSync("which", ["git"], { encoding: "utf8" }).trim(),
  );
  assert.throws(() => resolveGit("git", "relative/bin"), /Cannot find git/);
});

test("creates an isolated checkout without hooks, filters, inherited git environment or dirty files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "superagent-worktree-"));
  const source = join(dir, "repo"),
    storage = join(dir, "work");
  await mkdir(source);
  const git = (...args: string[]) =>
    execFileSync("/usr/bin/git", args, { cwd: source, encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    await writeFile(join(source, "file"), "committed\n");
    await writeFile(join(source, ".gitattributes"), "file filter=unsafe\n");
    git("add", ".");
    git("commit", "-qm", "initial");
    git(
      "config",
      "filter.unsafe.smudge",
      `touch ${join(dir, "smudge-executed")}`,
    );
    git("config", "filter.unsafe.required", "true");
    const included = join(dir, "included.gitconfig");
    await writeFile(
      included,
      `[filter "unsafe"]\n\tsmudge = touch ${join(dir, "included-filter-executed")}\n\trequired = true\n`,
    );
    git("config", "--unset-all", "filter.unsafe.smudge");
    git("config", "--unset-all", "filter.unsafe.required");
    git("config", "include.path", included);
    await writeFile(
      join(source, ".git", "hooks", "post-checkout"),
      `#!/bin/sh\ntouch ${join(dir, "hook-executed")}\n`,
      { mode: 0o755 },
    );
    await writeFile(join(source, "file"), "dirty user work\n");
    const trees = new Worktrees("/usr/bin/git", source, storage);
    const checkout = await trees.prepare("ticket-1");
    assert.equal(await readFile(join(checkout, "file"), "utf8"), "committed\n");
    assert.equal(
      await readFile(join(source, "file"), "utf8"),
      "dirty user work\n",
    );
    await assert.rejects(readFile(join(dir, "smudge-executed")));
    await assert.rejects(readFile(join(dir, "hook-executed")));
    await assert.rejects(readFile(join(dir, "included-filter-executed")));
    assert.equal(await trees.prepare("ticket-1"), checkout);
    await assert.rejects(trees.prepare("../../escape"));
    assert.equal(await trees.ticketAt(checkout), "ticket-1");
    execFileSync("/usr/bin/git", ["switch", "--detach"], { cwd: checkout });
    await assert.rejects(trees.ticketAt(checkout), /branch|detached/i);
    execFileSync(
      "/usr/bin/git",
      ["symbolic-ref", "HEAD", "refs/heads/superagent/ticket-1"],
      { cwd: checkout },
    );
    assert.equal(await trees.ticketAt(source), undefined);
    await rm(join(storage, ".ticket-1.ready"));
    await assert.rejects(trees.prepare("ticket-1"), /incomplete/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function repositoryFixture() {
  const directory = await mkdtemp(join(tmpdir(), "superagent-validate-worktree-"));
  const source = join(directory, "repo"), storage = join(directory, "work");
  const git = (cwd: string, ...args: string[]) => execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const init = async (root: string) => {
    await mkdir(root);
    git(root, "init", "-q"); git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.invalid");
    await writeFile(join(root, "file"), "committed\n"); git(root, "add", "."); git(root, "commit", "-qm", "initial");
  };
  await init(source);
  const trees = new Worktrees("/usr/bin/git", source, storage);
  return { directory, source, storage, trees, git, init, close: () => rm(directory, { recursive: true, force: true }) };
}

test("saved worktree validation is read-only and preserves operator work and Git binding", async () => {
  const f = await repositoryFixture();
  try {
    const checkout = await f.trees.prepare("ticket-1"), binding = await readFile(join(checkout, ".git"), "utf8");
    const marker = await readFile(join(f.storage, ".ticket-1.ready"), "utf8");
    await writeFile(join(checkout, "file"), "operator changes\n"); await writeFile(join(checkout, "untracked"), "operator scratch\n");
    assert.equal(await f.trees.validate("ticket-1", checkout), checkout);
    assert.equal(await f.trees.validate("ticket-1", checkout), checkout);
    assert.equal(await readFile(join(checkout, "file"), "utf8"), "operator changes\n");
    assert.equal(await readFile(join(checkout, "untracked"), "utf8"), "operator scratch\n");
    assert.equal(await readFile(join(checkout, ".git"), "utf8"), binding);
    assert.equal(await readFile(join(f.storage, ".ticket-1.ready"), "utf8"), marker);
    await assert.rejects(f.trees.validate("ticket-2", checkout), /does not match/);
    await assert.rejects(f.trees.validate("..", checkout), /Invalid ticket/);
    await rm(join(f.storage, ".ticket-1.ready"));
    await assert.rejects(f.trees.validate("ticket-1", checkout), /incomplete/);
    assert.equal(await readFile(join(checkout, "file"), "utf8"), "operator changes\n");
  } finally { await f.close(); }
});

test("saved validation refuses switched and detached branches without undoing operator changes", async () => {
  const f = await repositoryFixture();
  try {
    const checkout = await f.trees.prepare("ticket-1");
    await writeFile(join(checkout, "file"), "dirty branch work\n"); await writeFile(join(checkout, "untracked"), "scratch\n");
    f.git(checkout, "switch", "-c", "unrelated-human-work");
    const binding = await readFile(join(checkout, ".git"), "utf8");
    await assert.rejects(f.trees.validate("ticket-1", checkout), /branch changed|detached/i);
    assert.equal(f.git(checkout, "symbolic-ref", "--short", "HEAD").trim(), "unrelated-human-work");
    f.git(checkout, "switch", "--detach");
    const head = f.git(checkout, "rev-parse", "HEAD");
    await assert.rejects(f.trees.validate("ticket-1", checkout), /branch changed|detached/i);
    assert.equal(f.git(checkout, "rev-parse", "HEAD"), head);
    assert.throws(() => f.git(checkout, "symbolic-ref", "--quiet", "HEAD"));
    assert.equal(await readFile(join(checkout, "file"), "utf8"), "dirty branch work\n");
    assert.equal(await readFile(join(checkout, "untracked"), "utf8"), "scratch\n");
    assert.equal(await readFile(join(checkout, ".git"), "utf8"), binding);
  } finally { await f.close(); }
});

test("saved validation refuses missing or moved paths without creating a replacement checkout", async () => {
  const f = await repositoryFixture();
  try {
    const absent = join(f.directory, "absent-storage"), untouched = new Worktrees("/usr/bin/git", f.source, absent);
    await assert.rejects(untouched.validate("ticket-1", join(absent, "ticket-1")), /ENOENT/);
    await assert.rejects(lstat(absent), { code: "ENOENT" });
    const checkout = await f.trees.prepare("ticket-1"), moved = join(f.storage, "operator-moved");
    await writeFile(join(checkout, "file"), "moved operator work\n");
    const binding = await readFile(join(checkout, ".git"), "utf8");
    await rename(checkout, moved);
    const entries = await readdir(f.storage);
    await assert.rejects(f.trees.validate("ticket-1", checkout), /ENOENT/);
    await assert.rejects(f.trees.validate("ticket-1", moved), /does not match/);
    await assert.rejects(lstat(checkout), { code: "ENOENT" });
    assert.deepEqual(await readdir(f.storage), entries);
    assert.equal(await readFile(join(moved, "file"), "utf8"), "moved operator work\n");
    assert.equal(await readFile(join(moved, ".git"), "utf8"), binding);
  } finally { await f.close(); }
});

test("saved validation rejects symbolic storage and checkout paths without following them", async () => {
  const f = await repositoryFixture();
  try {
    const checkout = await f.trees.prepare("ticket-1"), moved = join(f.storage, "moved");
    await rename(checkout, moved); await symlink(moved, checkout, "dir");
    const binding = await readFile(join(moved, ".git"), "utf8");
    await assert.rejects(f.trees.validate("ticket-1", checkout), /Unsafe saved worktree/);
    await rm(checkout); await rename(moved, checkout);
    const alias = join(f.directory, "storage-alias"); await symlink(f.storage, alias, "dir");
    const aliased = new Worktrees("/usr/bin/git", f.source, alias);
    await assert.rejects(aliased.validate("ticket-1", join(alias, "ticket-1")), /Unsafe worktree storage/);
    const parent = join(f.directory, "parent"); await mkdir(parent); await symlink(f.directory, join(parent, "alias"), "dir");
    const ancestor = new Worktrees("/usr/bin/git", f.source, join(parent, "alias", "work"));
    await assert.rejects(ancestor.validate("ticket-1", join(parent, "alias", "work", "ticket-1")), /Unsafe worktree storage/);
    assert.equal(await readFile(join(checkout, ".git"), "utf8"), binding);
  } finally { await f.close(); }
});

test("saved validation rejects a foreign Git common directory without repairing its binding", async () => {
  const f = await repositoryFixture();
  try {
    const checkout = await f.trees.prepare("ticket-1"), foreign = join(f.directory, "foreign");
    await f.init(foreign);
    const other = new Worktrees("/usr/bin/git", foreign, join(f.directory, "foreign-work"));
    const foreignCheckout = await other.prepare("ticket-1");
    const changedBinding = await readFile(join(foreignCheckout, ".git"), "utf8");
    await writeFile(join(checkout, ".git"), changedBinding); await writeFile(join(checkout, "file"), "foreign-bound operator work\n");
    await assert.rejects(f.trees.validate("ticket-1", checkout), /another repository|does not match/);
    assert.equal(await readFile(join(checkout, ".git"), "utf8"), changedBinding);
    assert.equal(await readFile(join(checkout, "file"), "utf8"), "foreign-bound operator work\n");
  } finally { await f.close(); }
});

test("source common directory stays anchored while public lookup observes a retargeted source", async () => {
  const f = await repositoryFixture();
  try {
    const foreign = join(f.directory, "foreign"), sourceAlias = join(f.directory, "source-alias");
    await f.init(foreign); await symlink(f.source, sourceAlias, "dir");
    const trees = new Worktrees("/usr/bin/git", sourceAlias, f.storage), checkout = await trees.prepare("ticket-1");
    const original = await trees.commonDirectory(), binding = await readFile(join(checkout, ".git"), "utf8");
    await writeFile(join(checkout, "file"), "preserved operator work\n");
    await rm(sourceAlias); await symlink(foreign, sourceAlias, "dir");
    assert.notEqual(await trees.commonDirectory(), original);
    assert.equal(await trees.commonDirectory(), await realpath(join(foreign, ".git")));
    await assert.rejects(trees.validate("ticket-1", checkout), /Source repository changed/);
    await assert.rejects(trees.ticketAt(checkout), /Source repository changed/);
    await assert.rejects(trees.prepare("ticket-2"), /Source repository changed/);
    await assert.rejects(lstat(join(f.storage, "ticket-2")), { code: "ENOENT" });
    assert.equal(await readFile(join(checkout, ".git"), "utf8"), binding);
    assert.equal(await readFile(join(checkout, "file"), "utf8"), "preserved operator work\n");
  } finally { await f.close(); }
});
