import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import {
  resolveGitWorkspace,
  type GitCommandInput,
  type GitCommandResult,
} from "../../packages/butler-agent/src/agent/workspace/git-workspace-resolver.ts";

const now = () => "2026-06-18T00:00:00.000Z";

function tempDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function initRepo(): string {
  const repo = tempDir("git-workspace-resolver-repo-");
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.test"]);
  git(repo, ["config", "user.name", "Test User"]);
  writeFileSync(join(repo, "README.md"), "hello\n", "utf8");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

test("returns none when workspace path is missing", () => {
  const resolved = resolveGitWorkspace("", { now });
  expect(resolved.available).toBe(false);
  expect(resolved.workspaceMode).toBe("none");
  expect(resolved.capturedAt).toBe(now());
});

test("classifies a non-git folder", () => {
  const folder = tempDir("git-workspace-resolver-folder-");
  try {
    const resolved = resolveGitWorkspace(folder, { now });
    expect(resolved.available).toBe(false);
    expect(resolved.workspaceMode).toBe("folder");
    expect(resolved.workspacePath).toBe(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("resolves a normal git repository", () => {
  const repo = initRepo();
  try {
    const resolved = resolveGitWorkspace(repo, { now });
    expect(resolved.available).toBe(true);
    expect(resolved.workspaceMode).toBe("git-repository");
    expect(resolved.repoRoot).toBe(repo);
    expect(resolved.worktreePath).toBe(repo);
    expect(resolved.gitDir?.endsWith(".git")).toBe(true);
    expect(resolved.commonDir?.endsWith(".git")).toBe(true);
    expect(resolved.branch).toBe("main");
    expect(resolved.headSha).toHaveLength(40);
    expect(resolved.detached).toBe(false);
    expect(resolved.dirty).toBe(false);
    expect(resolved.isMainWorktree).toBe(true);
    expect(resolved.isLinkedWorktree).toBe(false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("classifies a subdirectory inside a normal git repository", () => {
  const repo = initRepo();
  const subdir = join(repo, "src", "nested");
  mkdirSync(subdir, { recursive: true });
  try {
    const resolved = resolveGitWorkspace(subdir, { now });
    expect(resolved.available).toBe(true);
    expect(resolved.workspaceMode).toBe("git-subdirectory");
    expect(resolved.workspacePath).toBe(subdir);
    expect(resolved.repoRoot).toBe(repo);
    expect(resolved.isLinkedWorktree).toBe(false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("detects a linked git worktree by git topology", () => {
  const repo = initRepo();
  const parent = tempDir("git-workspace-resolver-worktrees-");
  const linked = join(parent, "linked-checkout");
  try {
    git(repo, ["worktree", "add", "-b", "feature/resolver", linked]);
    const resolved = resolveGitWorkspace(linked, { now });
    expect(resolved.available).toBe(true);
    expect(resolved.workspaceMode).toBe("git-worktree");
    expect(resolved.repoRoot).toBe(linked);
    expect(resolved.worktreePath).toBe(linked);
    expect(resolved.commonDir?.endsWith(".git")).toBe(true);
    expect(resolved.gitDir).not.toBe(resolved.commonDir);
    expect(resolved.branch).toBe("feature/resolver");
    expect(resolved.isMainWorktree).toBe(false);
    expect(resolved.isLinkedWorktree).toBe(true);
  } finally {
    spawnSync("git", ["-C", repo, "worktree", "remove", "--force", linked], { encoding: "utf8" });
    rmSync(parent, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("reports dirty and detached states", () => {
  const repo = initRepo();
  try {
    const head = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "--detach", head]);
    writeFileSync(join(repo, "dirty.txt"), "dirty\n", "utf8");
    const resolved = resolveGitWorkspace(repo, { now });
    expect(resolved.workspaceMode).toBe("git-repository");
    expect(resolved.branch).toBeUndefined();
    expect(resolved.detached).toBe(true);
    expect(resolved.dirty).toBe(true);
    expect(resolved.headSha).toBe(head);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("returns unknown when git command execution fails unexpectedly", () => {
  const folder = tempDir("git-workspace-resolver-unknown-");
  const runGit = (input: GitCommandInput): GitCommandResult => ({
    ok: false,
    stdout: "",
    stderr: "",
    error: { code: input.args[0] === "rev-parse" ? "GIT_TIMEOUT" : "GIT_FAILED", message: "timed out" },
  });
  try {
    const resolved = resolveGitWorkspace(folder, { now, runGit });
    expect(resolved.available).toBe(false);
    expect(resolved.workspaceMode).toBe("unknown");
    expect(resolved.error?.code).toBe("GIT_TIMEOUT");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
