import type { ContentRef, WorkspaceOperationRoot } from "../core/index.ts";
import type { WorkspaceProvision } from "../artifact/index.ts";
import type { ReviewedPromotionAssembly } from "../artifact/index.ts";
import type { FinalDossierProduct } from "../consolidation/index.ts";
import type { ReviewedManagedProgramState } from "../work-ledger/index.ts";

export type ManagedAttempt = {
  ref: ContentRef;
  taskRef: ContentRef;
  owningTurnId: string;
  createdByTurnRevision: number;
  previousAttemptRef?: ContentRef;
  correctionPlanRef?: ContentRef;
  executionTargetRef: ContentRef;
  executionTarget: {
    ref: ContentRef;
    taskRef: ContentRef;
    attemptRef: ContentRef;
    target:
      | { kind: "non_artifact"; targetScopeRefs: string[] }
      | {
          kind: "provisioned_workspace";
          provisionOutcomeRef: ContentRef;
          workspaceRef: ContentRef;
          baselineRef: ContentRef;
          baselineSnapshotRef: ContentRef;
          acceptedBaseRevisionRefs: ContentRef[];
          operationRoot: WorkspaceOperationRoot;
        }
      | {
          kind: "repository_promotion";
          authorizationRef: ContentRef;
          workspaceRef: ContentRef;
          candidateRef: ContentRef;
          resolutionRef: ContentRef;
          baselineRef: ContentRef;
          finalSnapshotRef: ContentRef;
        };
  };
  executionTargetBinding: {
    ref: ContentRef;
    programId: string;
    taskRef: ContentRef;
    attemptRef: ContentRef;
    executionTargetRef: ContentRef;
    creation:
      | { kind: "accepted_non_artifact_selection" }
      | { kind: "observed_workspace_provision"; provisionOutcomeRef: ContentRef }
      | {
          kind: "authorized_promotion_selection";
          authorizationRef: ContentRef;
          resolutionRef: ContentRef;
        };
  };
  workspaceProvision?: WorkspaceProvision;
  status:
    | "ready" | "result_submitted" | "review_failed" | "accepted"
    | "promotion_deferred" | "closed_unaccepted";
};

export type WorkFrontierDecision =
  | {
      kind: "select_task";
      task: ReviewedManagedProgramState["tasks"][number];
    }
  | { kind: "close_frontier"; promotionAssemblies: ReviewedPromotionAssembly[] }
  | { kind: "complete_promotion"; product: FinalDossierProduct }
  | { kind: "defer_promotion"; product: FinalDossierProduct };
