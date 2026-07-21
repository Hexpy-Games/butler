import type { ContentRef } from "../core/index.ts";

export type WorkspaceProvision = {
  outbox: {
    ref: ContentRef;
    turnId: string;
    turnRevision: number;
    programId: string;
    workRef: ContentRef;
    taskRef: ContentRef;
    attemptRef: ContentRef;
    targetScopeRef: string;
    baselinePolicy: "capture_at_workspace_provision" | "exact_planned_revision";
  };
  baseline: {
    ref: ContentRef;
    targetScopeRef: string;
    capturedByProvisionOutboxRef: ContentRef;
    snapshotRef: ContentRef;
  };
  workspace: {
    ref: ContentRef;
    programId: string;
    provisionOutboxRef: ContentRef;
    targetBaselineRef: ContentRef;
    ownedRootRef: ContentRef;
  };
  receipt: {
    ref: ContentRef;
    workspaceRef: ContentRef;
    outboxRef: ContentRef;
    targetBaselineRef: ContentRef;
    ownerMarkerSha256: string;
  };
  outcome: {
    ref: ContentRef;
    outboxRef: ContentRef;
    receiptRef: ContentRef;
    observedTargetRevisionRefs: ContentRef[];
  };
};

export type ProvisionWorkspaceCommand = {
  turnId: string;
  turnRevision: number;
  programId: string;
  workRef: ContentRef;
  taskRef: ContentRef;
  attemptRef: ContentRef;
  targetScopeRef: string;
  baselinePolicy: "capture_at_workspace_provision" | "exact_planned_revision";
};

export interface ArtifactWorkspaceRuntime {
  acquireProgramWorkspace(command: ProvisionWorkspaceCommand): Promise<WorkspaceProvision>;
}

export type ReviewedPromotionAssembly = {
  candidate: {
    ref: ContentRef;
    programId: string;
    workspaceRef: ContentRef;
    implementationReviewRefs: ContentRef[];
    integrationReviewRef: ContentRef;
    acceptedWorkspaceRevisionRefs: ContentRef[];
    finalSnapshotRef: ContentRef;
    finalArtifactRevisionRefs: ContentRef[];
    promotionTaskRef: ContentRef;
  };
  resolution: {
    ref: ContentRef;
    selectorRef: ContentRef;
    candidateRef: ContentRef;
    baselineRef: ContentRef;
    exactFrontierTaskRefs: ContentRef[];
  };
};
