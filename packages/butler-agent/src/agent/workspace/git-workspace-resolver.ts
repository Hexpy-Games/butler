import { existsSync, realpathSync, statSync } from "fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "path";
import { spawnSync, type SpawnSyncReturns } from "child_process";

export type GitWorkspaceMode = "none" | "folder" | "git-repository" | "git-worktree" | "git-subdirectory" | "unknown";

export interface GitWorkspaceMetadata {
  available: boolean;
  workspaceMode: GitWorkspaceMode;
  workspacePath: string;
  repoRoot?: string;
  worktreePath?: string;
  commonDir?: string;
  gitDir?: string;
  branch?: string;
  headSha?: string;
  detached?: boolean;
  dirty?: boolean;
  upstream?: string;
  isMainWorktree?: boolean;
  isLinkedWorktree?: boolean;
  capturedAt: string;
  error?: { code: string; message: string };
}

export interface ResolveGitWorkspaceOptions {
  timeoutMs?: number;
  now?: () => string;
  runGit?: GitCommandRunner;
}

export type GitCommandRunner = (input: GitCommandInput) => GitCommandResult;

export interface GitCommandInput {
  cwd: string;
  args: string[];
  timeoutMs: number;
}

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code?: number | null;
  error?: { code: string; message: string };
}

const DEFAULT_TIMEOUT_MS = 1_500;

export function resolveGitWorkspace(
  workspacePath: string | null | undefined,
  options: ResolveGitWorkspaceOptions = {},
): GitWorkspaceMetadata {
  const capturedAt = (options.now ?? (() => new Date().toISOString()))();
  const normalizedWorkspace = normalizeWorkspacePath(workspacePath);
  if (!normalizedWorkspace || !existsSync(normalizedWorkspace)) {
    return {
      available: false,
      workspaceMode: "none",
      workspacePath: normalizedWorkspace ?? "",
      capturedAt,
    };
  }

  try {
    if (!statSync(normalizedWorkspace).isDirectory()) {
      return {
        available: false,
        workspaceMode: "folder",
        workspacePath: normalizedWorkspace,
        capturedAt,
      };
    }
  } catch (error) {
    return unknownMetadata(normalizedWorkspace, capturedAt, "WORKSPACE_STAT_FAILED", errorMessage(error));
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runGit = options.runGit ?? defaultGitRunner;
  const run = (args: string[]) => runGit({ cwd: normalizedWorkspace, args, timeoutMs });

  const insideWorkTree = run(["rev-parse", "--is-inside-work-tree"]);
  if (!insideWorkTree.ok) {
    if (isGitUnavailable(insideWorkTree)) {
      return unknownMetadata(
        normalizedWorkspace,
        capturedAt,
        insideWorkTree.error?.code ?? "GIT_COMMAND_FAILED",
        insideWorkTree.error?.message ?? stderrOrFallback(insideWorkTree, "Git inspection failed"),
      );
    }
    return {
      available: false,
      workspaceMode: "folder",
      workspacePath: normalizedWorkspace,
      capturedAt,
    };
  }
  if (insideWorkTree.stdout.trim() !== "true") {
    return {
      available: false,
      workspaceMode: "folder",
      workspacePath: normalizedWorkspace,
      capturedAt,
    };
  }

  const repoRootResult = run(["rev-parse", "--show-toplevel"]);
  const gitDirResult = run(["rev-parse", "--git-dir"]);
  const commonDirResult = run(["rev-parse", "--git-common-dir"]);
  const headResult = run(["rev-parse", "HEAD"]);

  const requiredFailure = [repoRootResult, gitDirResult, commonDirResult, headResult].find((result) => !result.ok);
  if (requiredFailure) {
    return unknownMetadata(
      normalizedWorkspace,
      capturedAt,
      requiredFailure.error?.code ?? "GIT_COMMAND_FAILED",
      requiredFailure.error?.message ?? stderrOrFallback(requiredFailure, "Git inspection failed"),
    );
  }

  const repoRoot = normalizeAbsolute(repoRootResult.stdout.trim(), normalizedWorkspace);
  const gitDir = normalizeAbsolute(gitDirResult.stdout.trim(), normalizedWorkspace);
  const commonDir = normalizeAbsolute(commonDirResult.stdout.trim(), normalizedWorkspace);
  const branchResult = run(["branch", "--show-current"]);
  const statusResult = run(["status", "--porcelain"]);
  const upstreamResult = run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);

  const branch = branchResult.ok ? emptyToUndefined(branchResult.stdout.trim()) : undefined;
  const detached = branch === undefined;
  const dirty = statusResult.ok ? statusResult.stdout.length > 0 : undefined;
  const upstream = upstreamResult.ok ? emptyToUndefined(upstreamResult.stdout.trim()) : undefined;
  const isLinkedWorktree = detectLinkedWorktree({ repoRoot, gitDir, commonDir });
  const isMainWorktree = isLinkedWorktree === undefined ? undefined : !isLinkedWorktree;
  const workspaceMode = classifyWorkspaceMode({
    workspacePath: normalizedWorkspace,
    repoRoot,
    isLinkedWorktree: isLinkedWorktree === true,
  });

  return {
    available: true,
    workspaceMode,
    workspacePath: normalizedWorkspace,
    repoRoot,
    worktreePath: repoRoot,
    commonDir,
    gitDir,
    branch,
    headSha: headResult.stdout.trim(),
    detached,
    dirty,
    upstream,
    isMainWorktree,
    isLinkedWorktree,
    capturedAt,
    ...(branchResult.ok && statusResult.ok ? {} : bestEffortError(branchResult, statusResult)),
  };
}

function normalizeWorkspacePath(workspacePath: string | null | undefined): string | undefined {
  const trimmed = workspacePath?.trim();
  if (!trimmed) return undefined;
  const absolute = resolve(trimmed);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function defaultGitRunner(input: GitCommandInput): GitCommandResult {
  let result: SpawnSyncReturns<Buffer>;
  try {
    result = spawnSync("git", input.args, {
      cwd: input.cwd,
      timeout: input.timeoutMs,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return { ok: false, stdout: "", stderr: "", error: { code: "GIT_SPAWN_FAILED", message: errorMessage(error) } };
  }

  const stdout = result.stdout?.toString("utf8") ?? "";
  const stderr = result.stderr?.toString("utf8") ?? "";
  if (result.error) {
    const nodeError = result.error as NodeJS.ErrnoException;
    return {
      ok: false,
      stdout,
      stderr,
      code: result.status,
      error: {
        code: result.signal === "SIGTERM" ? "GIT_TIMEOUT" : nodeError.code ?? "GIT_COMMAND_ERROR",
        message: nodeError.message,
      },
    };
  }

  return {
    ok: result.status === 0,
    stdout: stdout.replace(/\r?\n$/, ""),
    stderr: stderr.replace(/\r?\n$/, ""),
    code: result.status,
  };
}

function normalizeAbsolute(path: string, cwd: string): string {
  const absolute = normalize(isAbsolute(path) ? path : join(cwd, path));
  return trimTrailingPathSeparator(absolute);
}

function detectLinkedWorktree(input: { repoRoot: string; gitDir: string; commonDir: string }): boolean | undefined {
  const gitDir = trimTrailingPathSeparator(normalize(input.gitDir));
  const commonDir = trimTrailingPathSeparator(normalize(input.commonDir));
  const repoGitPath = trimTrailingPathSeparator(normalize(join(input.repoRoot, ".git")));

  if (gitDir === commonDir) return false;
  if (gitDir === repoGitPath) return false;

  // Main worktrees have .git as the common git dir. Linked worktrees have
  // their private git dir beneath the common dir, typically under
  // <commonDir>/worktrees/<id>. This is topology-based and does not inspect
  // the checked-out folder name.
  if (isDescendantPath(gitDir, commonDir)) return true;

  // If .git is a file in the working tree, gitDir points outside repoRoot while
  // commonDir points at the shared repository metadata. Treat that as linked.
  return commonDir !== repoGitPath;
}

function classifyWorkspaceMode(input: { workspacePath: string; repoRoot: string; isLinkedWorktree: boolean }): GitWorkspaceMode {
  if (input.isLinkedWorktree) return "git-worktree";
  const workspacePath = trimTrailingPathSeparator(normalize(input.workspacePath));
  const repoRoot = trimTrailingPathSeparator(normalize(input.repoRoot));
  return workspacePath === repoRoot ? "git-repository" : "git-subdirectory";
}

function isDescendantPath(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function trimTrailingPathSeparator(path: string): string {
  if (path.length <= 1) return path;
  return path.replace(/[\\/]+$/, "");
}

function unknownMetadata(workspacePath: string, capturedAt: string, code: string, message: string): GitWorkspaceMetadata {
  return {
    available: false,
    workspaceMode: "unknown",
    workspacePath,
    capturedAt,
    error: { code, message },
  };
}

function isGitUnavailable(result: GitCommandResult): boolean {
  const code = result.error?.code;
  return code === "ENOENT" || code === "GIT_SPAWN_FAILED" || code === "GIT_TIMEOUT" || code === "GIT_COMMAND_ERROR";
}

function stderrOrFallback(result: GitCommandResult, fallback: string): string {
  return result.stderr.trim() || result.error?.message || fallback;
}

function bestEffortError(...results: GitCommandResult[]): Pick<GitWorkspaceMetadata, "error"> {
  const failed = results.find((result) => !result.ok);
  if (!failed) return {};
  return {
    error: {
      code: failed.error?.code ?? "GIT_BEST_EFFORT_FAILED",
      message: failed.error?.message ?? stderrOrFallback(failed, "Best-effort Git metadata unavailable"),
    },
  };
}

function emptyToUndefined(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
