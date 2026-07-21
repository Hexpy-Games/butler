import type { ContentRef } from "../core/index.ts";
import type { OperationResult } from "../core/index.ts";

export type TargetStateRevision = {
  ref: ContentRef;
  targetScopeRef: string;
  state: "present" | "absent";
  description: string;
  observedByOperationRefs: ContentRef[];
};

export type WorkspaceRevision = {
  ref: ContentRef;
  workspaceRef: ContentRef;
  previousRef?: ContentRef;
  producingWorkRef: ContentRef;
  producingTaskRef: ContentRef;
  producingAttemptRef: ContentRef;
  baseAcceptedRevisionRefs: ContentRef[];
  artifactRevisionRefs: ContentRef[];
  targetSnapshotRef: ContentRef;
  producedByOperationRefs: ContentRef[];
};

type ResultBase = {
  ref: ContentRef;
  turnId: string;
  goalContractRef: ContentRef;
  authorityRef: ContentRef;
  workRef: ContentRef;
  taskRef: ContentRef;
  taskRevisionSha256: string;
  attemptRef: ContentRef;
  executionTargetRef: ContentRef;
  executionCheckpointRef: string;
  resultSummaryRef: ContentRef;
  operationResultRefs: ContentRef[];
  unresolvedConditionRefs: [];
  targetStateRevisions: TargetStateRevision[];
  effectReceiptRefs: [];
};

export type ResultCandidateProduct = {
  kind: "result_candidate";
  result: ResultBase & (
    | { kind: "non_artifact"; artifactRevisionRefs: [] }
    | {
        kind: "workspace_artifact";
        workspaceRef: ContentRef;
        workspaceRevisionRef: ContentRef;
        workspaceRevision: WorkspaceRevision;
        artifactRevisionRefs: ContentRef[];
      }
    | {
        kind: "repository_promotion";
        authorizationRef: ContentRef;
        transactionRef: ContentRef;
        commitJournalRef: ContentRef;
        promotionReceiptRef: ContentRef;
        promotedSnapshotRef: ContentRef;
        promotionRecords: NonNullable<OperationResult["promotionRecords"]>;
        artifactRevisionRefs: ContentRef[];
      }
  );
};
