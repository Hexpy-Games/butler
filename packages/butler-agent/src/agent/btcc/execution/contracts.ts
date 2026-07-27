import type { ContentRef } from "../core/index.ts";
import type { OperationResult } from "../core/index.ts";
import type { OperationResultProjection } from "../operation-result/index.ts";

export type TargetStateRevision = {
  ref: ContentRef;
  target:
    | { kind: "scope"; scopeRef: string }
    | { kind: "workspace"; workspaceRef: ContentRef }
    | { kind: "repository"; finalSnapshotRef: ContentRef };
  operationResultRef: ContentRef;
  observationRef: ContentRef;
  outcome: OperationResultProjection["outcome"];
  targetSnapshotRef?: ContentRef;
};

export type ResultSummary = {
  ref: ContentRef;
  content: string;
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
  resultSummary: ResultSummary;
  operationResultRefs: ContentRef[];
  operationResultReadScopeRefs: string[];
  unresolvedConditionRefs: [];
  targetStateRevisions: TargetStateRevision[];
  effectReceiptRefs: ContentRef[];
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
