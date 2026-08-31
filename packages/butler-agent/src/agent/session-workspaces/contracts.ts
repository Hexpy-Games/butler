import type { CommandExecutor } from "../../runtime/command/contracts.ts";
import { resolve } from "node:path";

export const SESSION_WORKSPACE_BINDING_SCHEMA =
  "butler.session-workspace-binding.v1" as const;

export type SessionWorkspaceAction = "create" | "select";

export interface SessionWorkspaceBindingMarker {
  schema: typeof SESSION_WORKSPACE_BINDING_SCHEMA;
  ownership: "session";
  repositoryAnchorPath: string;
  branch: string;
  boundAt: string;
}

export interface WorkspaceReference {
  get(): string;
  set(path: string): void;
}

export class WorkspaceReferenceUnavailableError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "WorkspaceReferenceUnavailableError";
    this.code = code;
  }
}

export function createWorkspaceReference(initialPath: string): WorkspaceReference {
  let currentPath = resolve(initialPath);
  return {
    get: () => currentPath,
    set(path: string) {
      const next = path.trim();
      if (!next) throw new Error("workspace_reference_path_required");
      currentPath = resolve(next);
    },
  };
}

export function createUnavailableWorkspaceReference(
  code = "session_workspace_unavailable",
): WorkspaceReference {
  let unavailable = true;
  let currentPath = "";
  return {
    get: () => {
      if (unavailable) throw new WorkspaceReferenceUnavailableError(code);
      return currentPath;
    },
    set(path: string) {
      const next = path.trim();
      if (!next) throw new Error("workspace_reference_path_required");
      currentPath = resolve(next);
      unavailable = false;
    },
  };
}

export interface SessionWorkspaceBindingSnapshot {
  sessionId: string;
  workspacePath: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface SessionWorkspaceBindingStore {
  getBySessionId(sessionId: string): SessionWorkspaceBindingSnapshot | null;
  rebindWorkspace(input: {
    sessionId: string;
    expectedUpdatedAt: string;
    workspacePath: string;
    metadata: Record<string, unknown>;
    updatedAt?: string;
  }):
    | { status: "applied"; binding: SessionWorkspaceBindingSnapshot }
    | { status: "changed"; binding: SessionWorkspaceBindingSnapshot | null }
    | { status: "missing" };
}

export interface BindSessionGitWorktreeInput {
  action: SessionWorkspaceAction;
  branch: string;
  startPoint?: string;
  sessionId: string;
  projectName?: string;
  butlerData: string;
  bindingStore: SessionWorkspaceBindingStore;
  workspaceReference: WorkspaceReference;
  commandExecutor?: CommandExecutor;
  signal?: AbortSignal;
  now?: () => string;
}

export type SessionWorkspaceErrorCode =
  | "cancelled"
  | "partial_creation"
  | "session_binding_required"
  | "session_binding_changed"
  | "binding_persist_failed"
  | "git_not_installed"
  | "git_repository_required"
  | "invalid_branch"
  | "invalid_start_point"
  | "branch_already_checked_out"
  | "worktree_target_occupied"
  | "linked_worktree_not_found"
  | "session_workspace_unavailable"
  | "git_operation_failed";

export type BindSessionGitWorktreeResult =
  | {
      ok: true;
      action: SessionWorkspaceAction;
      bound: true;
      workspace_label: string;
      branch: string;
      dirty: boolean;
      source_dirty: boolean;
      idempotent: boolean;
    }
  | {
      ok: false;
      error: {
        code: SessionWorkspaceErrorCode;
        recoverable: true;
      };
      action?: SessionWorkspaceAction;
      branch?: string;
      dirty?: boolean;
    };

export type WorktreeEntry = {
  path: string;
  branch?: string;
  head?: string;
};
