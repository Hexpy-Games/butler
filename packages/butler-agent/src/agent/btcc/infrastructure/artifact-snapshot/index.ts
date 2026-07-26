export { ArtifactSnapshotRepository, resolveWorkspaceTarget, workspaceContentRoot } from "./snapshot-repository.ts";
export { copyWorkspaceControls } from "./source-inventory.ts";
export { removeOwnedRoot, syncCompleteTarget } from "./workspace-filesystem.ts";
export type { MaterializedSnapshot, SnapshotEntry, TargetKind } from "./contracts.ts";
