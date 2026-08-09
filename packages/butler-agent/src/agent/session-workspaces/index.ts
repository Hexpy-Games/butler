export {
  SESSION_WORKSPACE_BINDING_SCHEMA,
  createUnavailableWorkspaceReference,
  createWorkspaceReference,
} from "./contracts.ts";
export type {
  BindSessionGitWorktreeInput,
  BindSessionGitWorktreeResult,
  SessionWorkspaceAction,
  SessionWorkspaceBindingMarker,
  SessionWorkspaceBindingSnapshot,
  SessionWorkspaceBindingStore,
  SessionWorkspaceErrorCode,
  WorkspaceReference,
} from "./contracts.ts";
export { WorkspaceReferenceUnavailableError } from "./contracts.ts";
export { bindSessionGitWorktree } from "./bind.ts";
export {
  recoverSessionWorkspaceReference,
  resolveSessionWorkspaceAuthority,
  safeWorkspaceBasename,
  validateSessionWorkspaceAuthority,
} from "./recovery.ts";
export type {
  RecoveredSessionWorkspaceReference,
  SessionWorkspaceAuthority,
} from "./recovery.ts";
