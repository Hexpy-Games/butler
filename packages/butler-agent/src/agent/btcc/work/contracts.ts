import type {
  ContentRef,
  WorkspaceMutationScope,
  WorkspaceOperationRoot,
} from "../core/index.ts";
import type {
  PromotionPermit,
  ReviewedPromotionAssembly,
  WorkspaceProvision,
} from "../artifact/index.ts";
import type { TaskReviewProduct } from "../review/index.ts";
import type { ReviewedManagedProgramState } from "../work-ledger/index.ts";

export type AttemptRecord = {
  ref: ContentRef;
  taskRef: ContentRef;
  owningTurnId: string;
  createdByTurnRevision: number;
  previousAttemptRef?: ContentRef;
  correctionPlanRef?: ContentRef;
};

export type ManagedAttempt = {
  attemptRecord: AttemptRecord;
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
          mutationScope: WorkspaceMutationScope;
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
  review?: TaskReviewProduct;
  status:
    | "ready" | "result_submitted" | "review_failed" | "accepted"
    | "promotion_deferred" | "closed_unaccepted";
};

export type WorkFrontierDecision =
  | {
      kind: "select_task";
      task: ReviewedManagedProgramState["tasks"][number];
    }
  | {
      kind: "revalidate_task";
      task: ReviewedManagedProgramState["tasks"][number];
    }
  | {
      kind: "close_frontier";
      promotionAssemblies: ReviewedPromotionAssembly[];
      promotionPermit?: PromotionPermit;
    }
  | { kind: "complete_promotion" }
  | { kind: "defer_promotion"; deferredAnchorRef: ContentRef };
