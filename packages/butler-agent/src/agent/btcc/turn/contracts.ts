import type {
  AdmittedModelSelection,
  ButlerContextInput,
  FreshBtccTurnCommand,
} from "../contracts.ts";
import type { OpeningAnswerProduct } from "../conception/index.ts";
import type {
  FeedbackIntentProduct,
  GoalContractAcceptedProduct,
  GoalContractCandidateProduct,
  GoalContractRevisionRequiredProduct,
  OpeningContinuationProduct,
  OpeningWorkCancellationProduct,
} from "../conception/index.ts";
import type { ConsolidationRepairProduct, FinalDossierProduct } from "../consolidation/index.ts";
import type { ContentRef } from "../core/index.ts";
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
import type { FinalizationContinuation } from "../continuation/index.ts";
import type { TaskReviewProduct } from "../review/index.ts";
import type { ManagedAttempt } from "../work/index.ts";
import type {
  PromotionPermit,
  ReviewedPromotionAssembly,
} from "../artifact/index.ts";
import type { WorkLedgerCommit, WorkLedgerMutation } from "../work-ledger/index.ts";
import type { ManagedTurnState } from "./managed-turn-state.ts";
import type { ManagedDeferralProduct } from "../deferral/index.ts";
import type { PromotionDeferralProduct } from "../deferral/index.ts";
import type { ContinuationCandidate } from "../continuation/index.ts";
import type { TurnEvent } from "./turn-events.ts";

export type { TurnEvent } from "./turn-events.ts";

export type TurnSemanticState =
  | "admitted"
  | "conception_opening"
  | "assisted_answer"
  | "conception_deliberation"
  | "contract_review"
  | "planning"
  | "planning_review"
  | "work_frontier"
  | "task_execution"
  | "task_review"
  | "feedback_conception"
  | "feedback_planning"
  | "feedback_planning_review"
  | "consolidation"
  | "reporting"
  | "delivery_committed"
  | "delivered"
  | "cancelled";

export type TurnCheckpoint = {
  checkpointId: string;
  checkpointRevision: number;
  kind: "runtime" | "phase";
  semanticState: TurnSemanticState;
};

export type DeliveryOutbox = {
  outboxId: string;
  finalPayloadRef: { id: string; sha256: string };
  expectedMessageId: string;
  content: string;
  status: "pending" | "inserted" | "observed";
};

export type TurnRecord = {
  turnId: string;
  sessionId: string;
  inboxId: string;
  triggerKey: string;
  originalMessageId: string;
  originalMessage: string;
  modelSelection: AdmittedModelSelection;
  context: ButlerContextInput;
  continuationCandidates: ContinuationCandidate[];
  semanticState: TurnSemanticState;
  checkpoint?: TurnCheckpoint;
  route?: "direct" | "assisted" | "managed";
  openingAnswer?: OpeningAnswerProduct;
  managed?: ManagedTurnState;
  finalPayload?: {
    ref: ContentRef;
    content: string;
    contentSha256: string;
  };
  deliveryOutbox?: DeliveryOutbox;
  canonicalAssistantMessageId?: string;
  revision: number;
  executionFence: number;
  finalDisposition?: "completed" | "deferred" | "cancelled";
};

export type AdmissionInbox = {
  inboxId: string;
  turnId: string;
  admissionInputHash: string;
  status: "recorded" | "constructed";
};

export type AdmissionConstructionClaim = {
  claimId: string;
  inboxId: string;
};

export type StateExecutionClaim = {
  claimId: string;
  turnId: string;
  turnRevision: number;
  semanticState: TurnSemanticState;
  checkpointId: string;
  checkpointRevision: number;
  executionFence: number;
};

export type AcceptedTurnTransition =
  | {
      kind: "activate_opening";
      successor: "conception_opening";
      successorCheckpointKind: "phase";
    }
  | {
      kind: "accept_opening_answer";
      successor: "delivery_committed";
      successorCheckpointKind: "runtime";
      product: OpeningAnswerProduct;
      deliveryOutbox: DeliveryOutbox;
    }
  | {
      kind: "accept_opening_continuation";
      successor: "assisted_answer" | "conception_deliberation";
      product: OpeningContinuationProduct;
    }
  | {
      kind: "accept_work_cancellation";
      successor: "cancelled";
      product: OpeningWorkCancellationProduct;
      ledgerCommit: WorkLedgerCommit & {
        mutation: Extract<WorkLedgerMutation, { kind: "cancel_program" }>;
      };
    }
  | { kind: "submit_goal_candidate"; successor: "contract_review"; product: GoalContractCandidateProduct }
  | {
      kind: "request_goal_revision";
      successor: "conception_deliberation";
      product: GoalContractRevisionRequiredProduct;
    }
  | {
      kind: "accept_goal_contract";
      successor: "planning";
      product: GoalContractAcceptedProduct;
      ledgerCommit: WorkLedgerCommit & {
        mutation: Extract<WorkLedgerMutation, { kind: "bind_program" }>;
      };
    }
  | {
      kind: "accept_finalization_continuation";
      successor: "consolidation" | "reporting" | "delivery_committed";
      product: GoalContractAcceptedProduct;
      finalization: FinalizationContinuation;
      preparedReport?: PreparedReportProduct;
      deliveryOutbox?: DeliveryOutbox;
    }
  | { kind: "submit_plan_candidate"; successor: "planning_review"; product: PlanningCandidateProduct }
  | {
      kind: "request_plan_revision";
      successor: "planning";
      product: PlanningRevisionRequiredProduct;
    }
  | {
      kind: "accept_plan";
      successor: "work_frontier";
      product: PlanningAcceptedProduct;
      ledgerCommit: WorkLedgerCommit & {
        mutation: Extract<WorkLedgerMutation, { kind: "install_reviewed_plan" }>;
      };
    }
  | {
      kind: "select_work_task";
      successor: "task_execution";
      attempt: ManagedAttempt;
      ledgerCommit: WorkLedgerCommit & {
        mutation: Extract<WorkLedgerMutation, { kind: "select_attempt" }>;
      };
    }
  | {
      kind: "resume_task_review";
      successor: "task_review";
    }
  | {
      kind: "close_work_frontier";
      successor: "work_frontier" | "consolidation";
      promotionAssemblies: ReviewedPromotionAssembly[];
      promotionPermit?: PromotionPermit;
      ledgerCommit: WorkLedgerCommit & {
        mutation: Extract<WorkLedgerMutation, { kind: "close_implementation_frontier" }>;
      };
    }
  | {
      kind: "submit_result";
      successor: "task_review";
      product: ResultCandidateProduct;
      ledgerCommit: WorkLedgerCommit & {
        mutation: Extract<WorkLedgerMutation, { kind: "attach_result" }>;
      };
    }
  | {
      kind: "pass_task_review";
      successor: "work_frontier";
      product: TaskReviewProduct;
      ledgerCommit: WorkLedgerCommit & {
        mutation: Extract<WorkLedgerMutation, { kind: "attach_review" }>;
      };
    }
  | {
      kind: "fail_task_review";
      successor: "feedback_conception";
      product: TaskReviewProduct;
      ledgerCommit: WorkLedgerCommit & {
        mutation: Extract<WorkLedgerMutation, { kind: "attach_review" }>;
      };
    }
  | { kind: "accept_feedback_intent"; successor: "feedback_planning"; product: FeedbackIntentProduct }
  | { kind: "submit_feedback_plan"; successor: "feedback_planning_review"; product: FeedbackPlanProduct }
  | {
      kind: "request_feedback_plan_revision";
      successor: "feedback_planning" | "feedback_conception";
      product: FeedbackPlanningRevisionRequiredProduct;
    }
  | {
      kind: "accept_feedback_plan";
      successor: "work_frontier";
      product: FeedbackPlanningAcceptedProduct;
      ledgerCommit: WorkLedgerCommit & {
        mutation: Extract<WorkLedgerMutation, { kind: "accept_feedback_plan" }>;
      };
    }
  | {
      kind: "accept_managed_deferral";
      successor: "consolidation";
      product: ManagedDeferralProduct;
      ledgerCommit: WorkLedgerCommit & {
        mutation: Extract<WorkLedgerMutation, { kind: "accept_managed_deferral" }>;
      };
    }
  | {
      kind: "accept_promotion_deferral";
      successor: "work_frontier";
      product: PromotionDeferralProduct;
      ledgerCommit: WorkLedgerCommit & {
        mutation: Extract<WorkLedgerMutation, { kind: "accept_promotion_deferral" }>;
      };
    }
  | {
      kind: "require_consolidation_repair";
      successor: "feedback_conception";
      product: ConsolidationRepairProduct;
    }
  | { kind: "accept_final_dossier"; successor: "reporting"; product: FinalDossierProduct }
  | {
      kind: "complete_promoted_work";
      successor: "consolidation";
      ledgerCommit: WorkLedgerCommit & {
        mutation: Extract<WorkLedgerMutation, { kind: "close_promotion_frontier" }>;
      };
    }
  | {
      kind: "defer_promoted_work";
      successor: "consolidation";
      ledgerCommit: WorkLedgerCommit & {
        mutation: Extract<WorkLedgerMutation, { kind: "close_deferred_promotion_frontier" }>;
      };
    }
  | {
      kind: "accept_prepared_report";
      successor: "delivery_committed";
      product: PreparedReportProduct;
      deliveryOutbox: DeliveryOutbox;
    }
  | {
      kind: "observe_delivery";
      successor: "delivered";
      assistantMessageId: string;
    };

export type TurnTransitionRejection =
  | { kind: "state_event_mismatch"; state: TurnSemanticState; event: TurnEvent["kind"] }
  | {
      kind: "delivery_message_mismatch";
      expectedMessageId?: string;
      observedMessageId: string;
    };

export type TurnTransitionDecision =
  | { kind: "accepted"; transition: AcceptedTurnTransition }
  | { kind: "rejected_unchanged"; reason: TurnTransitionRejection };

export interface TurnAdmissionRepository {
  recordInbound(input: {
    command: FreshBtccTurnCommand;
    admissionInputHash: string;
  }): Promise<AdmissionInbox>;
  acquireAdmissionConstructionClaim(
    inbox: AdmissionInbox,
  ): Promise<AdmissionConstructionClaim>;
  constructTurn(
    inbox: AdmissionInbox,
    claim: AdmissionConstructionClaim,
  ): Promise<TurnRecord>;
}

export interface TurnStateRepository {
  findTurn(turnId: string): Promise<TurnRecord | null>;
  activateCommittedSuccessor(turnId: string): Promise<TurnRecord>;
  acquireStateExecutionClaim(turn: TurnRecord): Promise<StateExecutionClaim>;
  commitTransition(input: {
    turn: TurnRecord;
    claim: StateExecutionClaim;
    transition: AcceptedTurnTransition;
  }): Promise<void>;
  stopTurn(turnId: string): Promise<StopPersistenceOutcome>;
}

export type StopPersistenceOutcome =
  | { kind: "cancelled"; turnId: string }
  | { kind: "already_cancelled"; turnId: string }
  | { kind: "already_finalizing"; turnId: string }
  | { kind: "already_delivered"; turnId: string; messageId: string; content: string };

export type { ManagedTurnState } from "./managed-turn-state.ts";
export type { ManagedProgramState } from "../work-ledger/index.ts";
