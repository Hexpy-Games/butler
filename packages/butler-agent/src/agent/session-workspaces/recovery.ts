import { basename } from "node:path";
import type { CommandExecutor } from "../../runtime/command/contracts.ts";
import {
  readSessionWorkspaceMarker,
  publicWorkspaceLabel,
} from "./path.ts";
import { validateLinkedWorktree } from "./git.ts";
import type {
  SessionWorkspaceBindingMarker,
  SessionWorkspaceBindingSnapshot,
  SessionWorkspaceBindingStore,
  WorkspaceReference,
} from "./contracts.ts";
import {
  createUnavailableWorkspaceReference,
  createWorkspaceReference,
} from "./contracts.ts";

export type SessionWorkspaceAuthority =
  | {
      kind: "project";
      workspacePath?: string;
    }
  | {
      kind: "session_worktree";
      workspacePath: string;
      branch: string;
      workspaceLabel: string;
      marker: SessionWorkspaceBindingMarker;
    }
  | {
      kind: "unavailable";
      workspacePath: string;
      workspaceLabel: "Session worktree";
      safeErrorCode: "session_workspace_marker_invalid";
    };

/**
 * Resolves the durable session binding authority without inspecting or
 * repairing the filesystem. A marker, including a malformed marker, owns the
 * stored path; only an unmarked binding may inherit the project workspace.
 */
export function resolveSessionWorkspaceAuthority(input: {
  binding?: SessionWorkspaceBindingSnapshot | null;
  projectWorkspacePath?: string;
}): SessionWorkspaceAuthority {
  const binding = input.binding ?? null;
  const marker = readSessionWorkspaceMarker(binding?.metadata);
  if (marker === "invalid") {
    return {
      kind: "unavailable",
      workspacePath: binding?.workspacePath ?? input.projectWorkspacePath ?? "",
      workspaceLabel: "Session worktree",
      safeErrorCode: "session_workspace_marker_invalid",
    };
  }
  if (marker) {
    return {
      kind: "session_worktree",
      workspacePath: binding?.workspacePath ?? "",
      branch: marker.branch,
      workspaceLabel: publicWorkspaceLabel(marker.branch),
      marker,
    };
  }
  return {
    kind: "project",
    workspacePath: input.projectWorkspacePath ?? binding?.workspacePath,
  };
}

export function safeWorkspaceBasename(path: string | undefined): string {
  const value = path ? basename(path) : "";
  const safe = [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join("")
    .trim();
  return safe.slice(0, 80) || "Project";
}

export async function validateSessionWorkspaceAuthority(input: {
  authority: SessionWorkspaceAuthority;
  commandExecutor: CommandExecutor;
  signal?: AbortSignal;
}): Promise<
  | { ok: true; path: string; dirty: boolean }
  | {
      ok: false;
      code:
        | "cancelled"
        | "git_not_installed"
        | "session_workspace_unavailable";
    }
> {
  if (input.authority.kind === "project") {
    if (!input.authority.workspacePath?.trim()) {
      return { ok: false, code: "session_workspace_unavailable" };
    }
    return {
      ok: true,
      path: input.authority.workspacePath,
      dirty: false,
    };
  }
  if (input.authority.kind === "unavailable" || !input.authority.workspacePath) {
    return { ok: false, code: "session_workspace_unavailable" };
  }
  const result = await validateLinkedWorktree({
    executor: input.commandExecutor,
    anchorPath: input.authority.marker.repositoryAnchorPath,
    path: input.authority.workspacePath,
    branch: input.authority.branch,
    signal: input.signal,
  });
  if (result.ok) return result;
  if (result.code === "cancelled") return { ok: false, code: "cancelled" };
  if (result.code === "git_not_installed") return { ok: false, code: "git_not_installed" };
  return { ok: false, code: "session_workspace_unavailable" };
}

export interface RecoveredSessionWorkspaceReference {
  authority: SessionWorkspaceAuthority;
  workspaceReference: WorkspaceReference;
  validation:
    | { ok: true; path: string; dirty: boolean }
    | { ok: false; code: "cancelled" | "git_not_installed" | "session_workspace_unavailable" };
}

/**
 * Rehydrates the one durable session workspace reference at a turn/relaunch
 * boundary. Invalid or stale markers remain blocked, while the reviewed bind
 * tool can later call `set` on the returned reference after a successful CAS.
 */
export async function recoverSessionWorkspaceReference(input: {
  sessionId: string;
  bindingStore: SessionWorkspaceBindingStore;
  projectWorkspacePath?: string;
  commandExecutor: CommandExecutor;
  signal?: AbortSignal;
}): Promise<RecoveredSessionWorkspaceReference> {
  const authority = resolveSessionWorkspaceAuthority({
    binding: input.bindingStore.getBySessionId(input.sessionId),
    projectWorkspacePath: input.projectWorkspacePath,
  });
  if (authority.kind === "unavailable") {
    return {
      authority,
      workspaceReference: createUnavailableWorkspaceReference(authority.safeErrorCode),
      validation: { ok: false, code: authority.safeErrorCode === "session_workspace_marker_invalid"
        ? "session_workspace_unavailable"
        : authority.safeErrorCode },
    };
  }
  const validation = await validateSessionWorkspaceAuthority({
    authority,
    commandExecutor: input.commandExecutor,
    signal: input.signal,
  });
  return {
    authority,
    workspaceReference: validation.ok
      ? createWorkspaceReference(validation.path)
      : createUnavailableWorkspaceReference(validation.code),
    validation,
  };
}
