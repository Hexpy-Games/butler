import {
  OperationRejectedError,
  type OperationRequest,
  type OperationAuthority,
} from "../../core/index.ts";
import type { StoredWorkspace } from "./artifact-store.ts";
import {
  isWorkspaceControlPath,
  type MaterializedSnapshot,
  type SnapshotEntry,
} from "./target-snapshot.ts";

type WorkspaceAuthority = Extract<
  OperationAuthority["mutation"],
  { kind: "workspace_only" }
>;
type WorkspaceRequest = Extract<OperationRequest, { kind: "workspace_artifact_action" }>;

export function requireWorkspaceOperationRoot(
  workspace: StoredWorkspace,
  request: WorkspaceRequest,
): void {
  if (workspace.targetKind === "directory" || request.relativeTarget === "target") return;
  throw rejected(
    "workspace_target_mismatch",
    "A single-file workspace accepts only its declared target path.",
  );
}

export function workspaceCapabilityRejection(error: unknown): Error {
  if (error instanceof OperationRejectedError ||
    (error instanceof Error && error.name === "AbortError")) return error;
  return rejected(
    "capability_execution_failed",
    error instanceof Error ? error.message : "The workspace capability could not execute its input.",
  );
}

export function requireWorkspaceMutationRequest(
  authority: OperationAuthority,
  relativeTarget: string,
): WorkspaceAuthority {
  if (authority.mutation.kind !== "workspace_only") {
    throw rejected("workspace_authority_missing", "Task has no workspace mutation authority.");
  }
  if (!isContainedRelativePath(relativeTarget)) {
    throw rejected(
      "task_mutation_target_invalid",
      "Workspace operation target must be a normalized contained relative path.",
    );
  }
  const scope = authority.mutation.mutationScope;
  if (
    scope.kind === "contained_paths" &&
    !scope.writablePaths.some((path) => contains(path, relativeTarget))
  ) {
    throw rejected(
      "task_mutation_target_denied",
      "Workspace operation target is outside the accepted Task mutation scope.",
    );
  }
  return authority.mutation;
}

export function requireAcceptedWorkspaceDelta(
  authority: WorkspaceAuthority,
  before: MaterializedSnapshot,
  after: MaterializedSnapshot,
): void {
  const changes = changedEntries(before, after);
  const payloadChanges = changes.filter((change) => !isWorkspaceControlPath(change.path));
  if (payloadChanges.length === 0) return;
  if (authority.mutationScope.kind === "read_only") {
    throw rejected(
      "read_only_task_mutated_workspace",
      "Read-only Task operation produced a persistent workspace delta.",
    );
  }
  const writablePaths = authority.mutationScope.writablePaths;
  const denied = payloadChanges.find((change) => !isAuthorizedChange(
    change,
    writablePaths,
  ));
  if (denied) {
    throw rejected(
      "task_mutation_scope_escaped",
      `Workspace operation changed a path outside Task authority: ${denied.path}`,
    );
  }
}

function changedEntries(
  before: MaterializedSnapshot,
  after: MaterializedSnapshot,
): SnapshotEntry[] {
  const previous = new Map(before.entries.map((entry) => [entry.path, identity(entry)]));
  const current = new Map(after.entries.map((entry) => [entry.path, identity(entry)]));
  const paths = new Set([...previous.keys(), ...current.keys()]);
  return [...paths]
    .filter((path) => previous.get(path) !== current.get(path))
    .map((path) => after.entries.find((entry) => entry.path === path) ??
      before.entries.find((entry) => entry.path === path)!);
}

function identity(entry: SnapshotEntry): string {
  if (entry.kind === "file") return `${entry.kind}:${entry.mode}:${entry.contentSha256}`;
  if (entry.kind === "symlink") return `${entry.kind}:${entry.mode}:${entry.linkTarget}`;
  return `${entry.kind}:${entry.mode}`;
}

function isAuthorizedChange(change: SnapshotEntry, writablePaths: string[]): boolean {
  return writablePaths.some((path) =>
    contains(path, change.path) ||
    (change.kind === "directory" && contains(change.path, path)),
  );
}

function contains(parent: string, child: string): boolean {
  return parent === "." || child === parent || child.startsWith(`${parent}/`);
}

function isContainedRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  if (path.length > 1 && path[1] === ":") return false;
  if (path === "." || path === "target") return true;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function rejected(code: string, message: string): OperationRejectedError {
  return new OperationRejectedError(code, message);
}
