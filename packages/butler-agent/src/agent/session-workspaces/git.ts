import { existsSync, lstatSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandExecutor, CommandResult } from "../../runtime/command/contracts.ts";
import { canonicalPath, samePath } from "./path.ts";
import type { WorktreeEntry } from "./contracts.ts";

export async function git(
  executor: CommandExecutor,
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<CommandResult> {
  return await executor.execute({
    plan: { steps: [{ executable: "git", arguments: args }] },
    cwd,
    timeoutMs: 30_000,
    signal,
  });
}

export async function resolveRepositoryAnchor(
  path: string,
  executor: CommandExecutor,
): Promise<
  | { ok: true; path: string }
  | { ok: false; code: "git_not_installed" | "git_repository_required" | "session_workspace_unavailable" }
> {
  const candidate = resolve(path);
  if (!existsSync(candidate)) return { ok: false, code: "session_workspace_unavailable" };
  try {
    if (!statSync(candidate).isDirectory()) return { ok: false, code: "git_repository_required" };
  } catch {
    return { ok: false, code: "git_repository_required" };
  }
  const result = await git(executor, candidate, ["rev-parse", "--show-toplevel"]);
  if (result.error?.code === "ENOENT") return { ok: false, code: "git_not_installed" };
  if (result.exitCode !== 0 || !result.stdout.trim()) return { ok: false, code: "git_repository_required" };
  return { ok: true, path: canonicalPath(result.stdout.trim()) };
}

export async function listWorktrees(
  executor: CommandExecutor,
  anchorPath: string,
  signal?: AbortSignal,
): Promise<
  | { ok: true; entries: WorktreeEntry[] }
  | { ok: false; code: "cancelled" | "partial_creation" | "git_not_installed" | "git_repository_required" }
> {
  const result = await git(executor, anchorPath, ["worktree", "list", "--porcelain", "-z"], signal);
  if (result.cancelled || result.timedOut) return { ok: false, code: "cancelled" };
  if (result.error?.code === "ENOENT") return { ok: false, code: "git_not_installed" };
  if (result.exitCode !== 0) return { ok: false, code: "git_repository_required" };
  return { ok: true, entries: parseWorktrees(result.stdout) };
}

export async function localBranchExists(
  executor: CommandExecutor,
  anchorPath: string,
  branch: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await git(executor, anchorPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], signal);
  return result.exitCode === 0;
}

export async function validateLinkedWorktree(input: {
  executor: CommandExecutor;
  anchorPath: string;
  path: string;
  branch: string;
  signal?: AbortSignal;
}): Promise<
  | { ok: true; path: string; dirty: boolean }
  | { ok: false; code: "cancelled" | "partial_creation" | "linked_worktree_not_found" | "git_repository_required" | "git_not_installed" }
> {
  if (input.signal?.aborted) return { ok: false, code: "cancelled" };
  if (!existsSync(input.path)) return { ok: false, code: "linked_worktree_not_found" };
  try {
    if (lstatSync(input.path).isSymbolicLink()) return { ok: false, code: "linked_worktree_not_found" };
    const pathStat = statSync(input.path);
    if (!pathStat.isDirectory()) return { ok: false, code: "linked_worktree_not_found" };
  } catch {
    return { ok: false, code: "linked_worktree_not_found" };
  }
  const top = await git(input.executor, input.path, ["rev-parse", "--show-toplevel"], input.signal);
  if (top.cancelled || top.timedOut) return { ok: false, code: "cancelled" };
  if (top.error?.code === "ENOENT") return { ok: false, code: "git_not_installed" };
  if (top.exitCode !== 0) return { ok: false, code: "git_repository_required" };
  const worktrees = await listWorktrees(input.executor, input.anchorPath, input.signal);
  if (!worktrees.ok) return { ok: false, code: worktrees.code };
  const listed = worktrees.entries.find((entry) => samePath(entry.path, input.path) && entry.branch === input.branch);
  if (!listed) return { ok: false, code: "partial_creation" };
  const branchResult = await git(input.executor, input.path, ["symbolic-ref", "--quiet", "--short", "HEAD"], input.signal);
  if (branchResult.cancelled || branchResult.timedOut) return { ok: false, code: "cancelled" };
  if (branchResult.error?.code === "ENOENT") return { ok: false, code: "git_not_installed" };
  if (branchResult.exitCode !== 0 || branchResult.stdout.trim() !== input.branch) return { ok: false, code: "partial_creation" };
  const status = await inspectWorktreeDirty(input.executor, input.path, input.signal);
  if (!status.ok) return status;
  return { ok: true, path: canonicalPath(input.path), dirty: status.dirty };
}

export async function inspectWorktreeDirty(
  executor: CommandExecutor,
  path: string,
  signal?: AbortSignal,
): Promise<
  | { ok: true; dirty: boolean }
  | { ok: false; code: "cancelled" | "git_repository_required" | "git_not_installed" }
> {
  const status = await git(executor, path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], signal);
  if (status.cancelled || status.timedOut) return { ok: false, code: "cancelled" };
  if (status.error?.code === "ENOENT") return { ok: false, code: "git_not_installed" };
  if (status.exitCode !== 0) return { ok: false, code: "git_repository_required" };
  return { ok: true, dirty: Boolean(status.stdout) };
}

export async function inspectPartialCreation(
  executor: CommandExecutor,
  anchorPath: string,
  targetPath: string,
  branch: string,
): Promise<boolean> {
  if (!targetPath || !existsSync(targetPath)) return false;
  const listed = await listWorktrees(executor, anchorPath);
  return listed.ok && listed.entries.some((entry) => samePath(entry.path, targetPath) && entry.branch === branch);
}

function parseWorktrees(stdout: string): WorktreeEntry[] {
  const records: string[][] = [];
  let fields: string[] = [];
  for (const field of stdout.split("\0")) {
    if (!field) {
      if (fields.length > 0) records.push(fields);
      fields = [];
      continue;
    }
    fields.push(field);
  }
  if (fields.length > 0) records.push(fields);
  return records.reduce<WorktreeEntry[]>((entries, fields) => {
    const lines = fields.flatMap((field) => field.split(/\r?\n/u));
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (!path) return entries;
    const head = lines.find((line) => line.startsWith("HEAD "))?.slice("HEAD ".length);
    const branchRef = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
    entries.push({
      path: canonicalPath(path),
      ...(head ? { head } : {}),
      ...(branchRef?.startsWith("refs/heads/") ? { branch: branchRef.slice("refs/heads/".length) } : {}),
    });
    return entries;
  }, []);
}
