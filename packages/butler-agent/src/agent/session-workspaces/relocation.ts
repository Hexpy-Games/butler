import { resolve } from "node:path";
import { statSync } from "node:fs";
import { createPlatformCommandExecutor } from "../../runtime/command/platform-command-executor.ts";
import type { CommandExecutor } from "../../runtime/command/contracts.ts";
import { SESSION_WORKSPACE_BINDING_SCHEMA, type SessionWorkspaceBindingMarker } from "./contracts.ts";
import { shortSessionWorktreeBranch } from "./branch.ts";
import { canonicalPath, deterministicTargetPath, ensureSessionWorktreeRoot, pathOccupied, samePath } from "./path.ts";
import { git, listWorktrees, resolveRepositoryAnchor, validateLinkedWorktree } from "./git.ts";

export interface PreparedRelocationWorkspace {
  operationId: string;
  workspacePath: string;
  marker: SessionWorkspaceBindingMarker | null;
  created: boolean;
}

/** Prepare only: changing a stored binding belongs to the relocation transaction. */
export async function prepareWorkspaceForRelocation(input: {
  sessionId: string; operationId: string; butlerData: string;
  projectPath: string | null; projectName?: string;
  signal?: AbortSignal; executor?: CommandExecutor;
  onPrepared?: (workspace: PreparedRelocationWorkspace) => void;
}): Promise<PreparedRelocationWorkspace> {
  if (!input.projectPath) return { operationId: input.operationId, workspacePath: resolve(input.butlerData), marker: null, created: false };
  if (!statSync(input.projectPath).isDirectory()) throw new Error("session_workspace_unavailable");
  const executor = input.executor ?? createPlatformCommandExecutor();
  const anchor = await resolveRepositoryAnchor(input.projectPath, executor);
  if (!anchor.ok) {
    if (anchor.code !== "git_repository_required") throw new Error(anchor.code);
    return { operationId: input.operationId, workspacePath: canonicalPath(input.projectPath), marker: null, created: false };
  }
  const branch = shortSessionWorktreeBranch(`${input.sessionId}:${input.operationId}`);
  const targetPath = deterministicTargetPath(input.butlerData, input.sessionId, branch, input.projectName);
  const listed = await listWorktrees(executor, anchor.path, input.signal);
  if (!listed.ok) throw new Error(listed.code);
  const existing = listed.entries.find(entry => samePath(entry.path, targetPath) && entry.branch === branch);
  if (!existing && pathOccupied(targetPath)) throw new Error("worktree_target_occupied");
  ensureSessionWorktreeRoot(input.butlerData, targetPath);
  const prepared: PreparedRelocationWorkspace = {
    operationId: input.operationId, workspacePath: targetPath, created: true,
    marker: { schema: SESSION_WORKSPACE_BINDING_SCHEMA, ownership: "session", repositoryAnchorPath: anchor.path, branch, boundAt: new Date().toISOString() },
  };
  // Persist the operation-owned target before creating files, so an interrupted
  // prepare can be reclaimed without guessing paths or touching older worktrees.
  input.onPrepared?.(prepared);
  try {
    if (!existing) {
      const result = await git(executor, anchor.path, ["worktree", "add", "-b", branch, targetPath, "HEAD"], input.signal);
      if (result.cancelled || result.timedOut) throw new Error("worktree_preparation_cancelled");
      if (result.exitCode !== 0) throw new Error("worktree_preparation_failed");
    }
    const validated = await validateLinkedWorktree({ executor, anchorPath: anchor.path, path: targetPath, branch, signal: input.signal });
    if (!validated.ok) throw new Error(validated.code);
    return prepared;
  } catch (error) {
    await discardRelocationWorkspace(prepared, executor);
    throw error;
  }
}

/** Remove only this operation's linked worktree, and only if Git considers it clean. */
export async function discardRelocationWorkspace(prepared: PreparedRelocationWorkspace, executor = createPlatformCommandExecutor()): Promise<boolean> {
  if (!prepared.created || !prepared.marker) return true;
  const { repositoryAnchorPath: anchor, branch } = prepared.marker;
  const listed = await listWorktrees(executor, anchor);
  if (!listed.ok) return false;
  if (!listed.entries.some(entry => samePath(entry.path, prepared.workspacePath) && entry.branch === branch)) return !pathOccupied(prepared.workspacePath);
  const removed = await git(executor, anchor, ["worktree", "remove", prepared.workspacePath]);
  if (removed.exitCode !== 0) return false;
  await git(executor, anchor, ["branch", "-d", branch]);
  return true;
}
