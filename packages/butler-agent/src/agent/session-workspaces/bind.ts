import type { CommandExecutor } from "../../runtime/command/contracts.ts";
import { createPlatformCommandExecutor } from "../../runtime/command/platform-command-executor.ts";
import {
  SESSION_WORKSPACE_BINDING_SCHEMA,
  type BindSessionGitWorktreeInput,
  type BindSessionGitWorktreeResult,
  type SessionWorkspaceAction,
  type SessionWorkspaceErrorCode,
  type SessionWorkspaceBindingMarker,
} from "./contracts.ts";
import {
  deterministicTargetPath,
  ensureSessionWorktreeRoot,
  isSafeRefInput,
  normalizeBranch,
  normalizeStartPoint,
  pathOccupied,
  publicWorkspaceLabel,
  readSessionWorkspaceMarker,
  samePath,
} from "./path.ts";
import {
  git,
  inspectPartialCreation,
  inspectWorktreeDirty,
  listWorktrees,
  localBranchExists,
  resolveRepositoryAnchor,
  validateLinkedWorktree,
} from "./git.ts";

export type { BindSessionGitWorktreeInput, BindSessionGitWorktreeResult } from "./contracts.ts";

const sessionLocks = new Map<string, Promise<void>>();

export async function bindSessionGitWorktree(
  input: BindSessionGitWorktreeInput,
): Promise<BindSessionGitWorktreeResult> {
  const previous = sessionLocks.get(input.sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  sessionLocks.set(input.sessionId, queued);
  await previous;
  try {
    return await bindSessionGitWorktreeUnlocked(input);
  } finally {
    release();
    if (sessionLocks.get(input.sessionId) === queued) sessionLocks.delete(input.sessionId);
  }
}

async function bindSessionGitWorktreeUnlocked(
  input: BindSessionGitWorktreeInput,
): Promise<BindSessionGitWorktreeResult> {
  const action = input.action;
  const branch = normalizeBranch(input.branch);
  if (!branch || !isSafeRefInput(branch)) return failure("invalid_branch", action);
  if (action === "select" && input.startPoint !== undefined) return failure("invalid_start_point", action, branch);
  const startPoint = action === "create" && input.startPoint !== undefined
    ? normalizeStartPoint(input.startPoint)
    : undefined;
  if (action === "create" && input.startPoint !== undefined && (!startPoint || !isSafeRefInput(startPoint, { allowHead: true }))) {
    return failure("invalid_start_point", action, branch);
  }
  if (input.signal?.aborted) return failure("cancelled", action, branch);
  const binding = input.bindingStore.getBySessionId(input.sessionId);
  if (!binding) return failure("session_binding_required", action, branch);
  const marker = readSessionWorkspaceMarker(binding.metadata);
  if (binding.metadata && marker === "invalid") return failure("session_workspace_unavailable", action, branch);
  const anchorPath = marker && marker !== "invalid" ? marker.repositoryAnchorPath : binding.workspacePath;
  const commandExecutor = input.commandExecutor ?? createPlatformCommandExecutor();
  const anchor = await resolveRepositoryAnchor(anchorPath, commandExecutor);
  if (!anchor.ok) return failure(anchor.code, action, branch);
  let derivedTargetPath: string | undefined;
  if (action === "create") {
    try {
      derivedTargetPath = deterministicTargetPath(input.butlerData, input.sessionId, branch);
      ensureSessionWorktreeRoot(input.butlerData, derivedTargetPath);
    } catch {
      return failure("worktree_target_occupied", action, branch);
    }
  }
  const branchCheck = await git(commandExecutor, anchor.path, ["check-ref-format", "--branch", branch], input.signal);
  if (branchCheck.cancelled || branchCheck.timedOut) {
    return cancellationOutcome(input, action, branch, derivedTargetPath ?? "", commandExecutor, anchor.path);
  }
  if (branchCheck.error?.code === "ENOENT") return failure("git_not_installed", action, branch);
  if (branchCheck.exitCode !== 0) return failure("invalid_branch", action, branch);
  const worktrees = await listWorktrees(commandExecutor, anchor.path, input.signal);
  if (!worktrees.ok) return failure(worktrees.code, action, branch);
  const branchEntries = worktrees.entries.filter((entry) => entry.branch === branch);
  const existingMarkerMatch = marker && marker !== "invalid" && marker.branch === branch;
  let targetPath: string;
  let idempotent = false;
  let reusableTarget = false;
  if (action === "select") {
    const selected = branchEntries[0];
    if (!selected) return failure("linked_worktree_not_found", action, branch);
    targetPath = selected.path;
    idempotent = Boolean(existingMarkerMatch && samePath(targetPath, binding.workspacePath));
  } else {
    targetPath = derivedTargetPath!;
    const targetEntry = worktrees.entries.find((entry) => samePath(entry.path, targetPath));
    if (branchEntries.length > 0 && (!targetEntry || targetEntry.branch !== branch)) {
      return failure("branch_already_checked_out", action, branch);
    }
    if (targetEntry && targetEntry.branch === branch) {
      reusableTarget = true;
      idempotent = Boolean(existingMarkerMatch && samePath(binding.workspacePath, targetPath));
    } else if (targetEntry || pathOccupied(targetPath)) {
      return failure("worktree_target_occupied", action, branch);
    }
    if (!reusableTarget) {
      const branchExists = await localBranchExists(commandExecutor, anchor.path, branch, input.signal);
      const args = branchExists
        ? ["worktree", "add", targetPath, branch]
        : ["worktree", "add", "-b", branch, targetPath, startPoint ?? "HEAD"];
      const created = await git(commandExecutor, anchor.path, args, input.signal);
      if (created.cancelled || created.timedOut) return cancellationOutcome(input, action, branch, targetPath, commandExecutor, anchor.path);
      if (created.error?.code === "ENOENT") return failure("git_not_installed", action, branch);
      if (created.exitCode !== 0) {
        const inspected = await inspectPartialCreation(commandExecutor, anchor.path, targetPath, branch);
        return inspected ? failure("partial_creation", action, branch) : failure("git_operation_failed", action, branch);
      }
    }
  }
  const validated = await validateLinkedWorktree({
    executor: commandExecutor,
    anchorPath: anchor.path,
    path: targetPath,
    branch,
    signal: input.signal,
  });
  if (!validated.ok) {
    if (validated.code === "cancelled") {
      return reusableTarget || action === "select"
        ? failure("cancelled", action, branch)
        : cancellationOutcome(input, action, branch, targetPath, commandExecutor, anchor.path);
    }
    return failure(validated.code, action, branch);
  }
  const sourceStatus = await inspectWorktreeDirty(commandExecutor, anchor.path, input.signal);
  if (!sourceStatus.ok) {
    if (sourceStatus.code === "cancelled") {
      return reusableTarget || action === "select"
        ? failure("cancelled", action, branch)
        : cancellationOutcome(input, action, branch, targetPath, commandExecutor, anchor.path);
    }
    return failure(sourceStatus.code, action, branch);
  }
  const now = input.now?.() ?? new Date().toISOString();
  const nextMetadata = {
    ...(binding.metadata ?? {}),
    sessionWorkspace: {
      schema: SESSION_WORKSPACE_BINDING_SCHEMA,
      ownership: "session",
      repositoryAnchorPath: anchor.path,
      branch,
      boundAt: now,
    } satisfies SessionWorkspaceBindingMarker,
  };
  let persisted;
  try {
    persisted = input.bindingStore.rebindWorkspace({
      sessionId: input.sessionId,
      expectedUpdatedAt: binding.updatedAt,
      workspacePath: validated.path,
      metadata: nextMetadata,
      updatedAt: now,
    });
  } catch {
    return failure("binding_persist_failed", action, branch);
  }
  if (persisted.status === "missing") return failure("session_binding_required", action, branch);
  if (persisted.status === "changed") return failure("session_binding_changed", action, branch);
  input.workspaceReference.set(validated.path);
  return {
    ok: true,
    action,
    bound: true,
    workspace_label: publicWorkspaceLabel(branch),
    branch,
    dirty: validated.dirty,
    source_dirty: sourceStatus.dirty,
    idempotent,
  };
}

function failure(code: SessionWorkspaceErrorCode, action?: SessionWorkspaceAction, branch?: string): BindSessionGitWorktreeResult {
  return {
    ok: false,
    ...(action ? { action } : {}),
    ...(branch ? { branch } : {}),
    error: { code, recoverable: true },
  } as BindSessionGitWorktreeResult;
}

async function cancellationOutcome(
  _input: BindSessionGitWorktreeInput,
  action: SessionWorkspaceAction,
  branch: string,
  targetPath: string,
  executor: CommandExecutor,
  anchorPath: string,
): Promise<BindSessionGitWorktreeResult> {
  if (await inspectPartialCreation(executor, anchorPath, targetPath, branch)) {
    return failure("partial_creation", action, branch);
  }
  return failure("cancelled", action, branch);
}
