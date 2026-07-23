import type {
  FeedbackIntentProduct,
  GoalContractAcceptedProduct,
  GoalContractCandidateProduct,
  GoalContractRevisionRequiredProduct,
  OpeningAnswerProduct,
  OpeningContinuationProduct,
} from "../conception/index.ts";
import type {
  ConsolidationRepairProduct,
  FinalDossierProduct,
} from "../consolidation/index.ts";
import type { PromotionDeferralProduct, ManagedDeferralProduct } from "../deferral/index.ts";
import type { ResultCandidateProduct } from "../execution/index.ts";
import type {
  FeedbackPlanProduct,
  FeedbackPlanningAcceptedProduct,
  FeedbackPlanningRevisionRequiredProduct,
  PlanningAcceptedProduct,
  PlanningCandidateProduct,
  PlanningRevisionRequiredProduct,
} from "../planning/index.ts";
import type { PreparedReportProduct } from "../reporting/index.ts";
import type { TaskReviewProduct } from "../review/index.ts";
import type {
  PromotionPermit,
  ReviewedPromotionAssembly,
} from "../artifact/index.ts";
import type { ManagedAttempt } from "../work/index.ts";

export type TurnEvent =
  | { kind: "TurnActivated" }
  | { kind: "OpeningAnswerAccepted"; product: OpeningAnswerProduct }
  | { kind: "OpeningContinuationAccepted"; product: OpeningContinuationProduct }
  | { kind: "GoalContractCandidateSubmitted"; product: GoalContractCandidateProduct }
  | { kind: "GoalContractReviewAccepted"; product: GoalContractAcceptedProduct }
  | { kind: "GoalContractRevisionRequested"; product: GoalContractRevisionRequiredProduct }
  | { kind: "PlanCandidateSubmitted"; product: PlanningCandidateProduct }
  | { kind: "PlanningReviewAccepted"; product: PlanningAcceptedProduct }
  | { kind: "PlanningRevisionRequested"; product: PlanningRevisionRequiredProduct }
  | { kind: "WorkTaskSelected"; attempt: ManagedAttempt }
  | { kind: "WorkTaskReadyForReview" }
  | {
      kind: "WorkFrontierClosed";
      promotionAssemblies: ReviewedPromotionAssembly[];
      promotionPermit?: PromotionPermit;
    }
  | { kind: "ResultCandidateSubmitted"; product: ResultCandidateProduct }
  | { kind: "TaskReviewPassed"; product: TaskReviewProduct }
  | { kind: "TaskReviewFailed"; product: TaskReviewProduct }
  | { kind: "FeedbackIntentAccepted"; product: FeedbackIntentProduct }
  | { kind: "FeedbackPlanCandidateSubmitted"; product: FeedbackPlanProduct }
  | { kind: "FeedbackPlanningReviewAccepted"; product: FeedbackPlanningAcceptedProduct }
  | { kind: "FeedbackPlanningRevisionRequested"; product: FeedbackPlanningRevisionRequiredProduct }
  | { kind: "ManagedDeferralAccepted"; product: ManagedDeferralProduct }
  | { kind: "PromotionDeferralAccepted"; product: PromotionDeferralProduct }
  | { kind: "ConsolidationRepairRequired"; product: ConsolidationRepairProduct }
  | { kind: "FinalDossierAccepted"; product: FinalDossierProduct }
  | {
      kind: "PromotionFrontierClosed";
      closure:
        | { kind: "promoted" }
        | { kind: "deferred"; deferredAnchorRef: import("../core/index.ts").ContentRef };
    }
  | { kind: "PreparedReportAccepted"; product: PreparedReportProduct }
  | { kind: "DeliveryObserved"; assistantMessageId: string };
