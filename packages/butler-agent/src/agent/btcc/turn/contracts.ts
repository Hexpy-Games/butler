import type {
  AdmittedModelSelection,
  BtccTurnCommand,
  ButlerContextInput,
} from "../contracts.ts";
import type { OpeningAnswerProduct } from "../conception/index.ts";
import type {
  FeedbackIntentProduct,
  GoalContractAcceptedProduct,
  GoalContractCandidateProduct,
  OpeningContinuationProduct,
} from "../conception/index.ts";
import type { FinalDossierProduct } from "../consolidation/index.ts";
import type { ContentRef } from "../core/index.ts";
import type { ResultCandidateProduct } from "../execution/index.ts";
import type {
  FeedbackPlanProduct,
  FeedbackPlanningAcceptedProduct,
  PlanningAcceptedProduct,
  PlanningCandidateProduct,
} from "../planning/index.ts";
import type { PreparedReportProduct } from "../reporting/index.ts";
import type { TaskReviewProduct } from "../review/index.ts";
import type { ManagedAttempt } from "../work/index.ts";
import type { ManagedTurnState } from "./managed-turn-state.ts";

export type TurnSemanticState =
  | "admitted"
  | "conception_opening"
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
  semanticState: TurnSemanticState;
  checkpoint?: TurnCheckpoint;
  route?: "direct" | "managed";
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
  finalDisposition?: "completed" | "cancelled";
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

export type TurnEvent =
  | { kind: "TurnActivated" }
  | { kind: "OpeningAnswerAccepted"; product: OpeningAnswerProduct }
  | { kind: "OpeningContinuationAccepted"; product: OpeningContinuationProduct }
  | { kind: "GoalContractCandidateSubmitted"; product: GoalContractCandidateProduct }
  | { kind: "GoalContractReviewAccepted"; product: GoalContractAcceptedProduct }
  | { kind: "PlanCandidateSubmitted"; product: PlanningCandidateProduct }
  | { kind: "PlanningReviewAccepted"; product: PlanningAcceptedProduct }
  | { kind: "WorkTaskSelected"; attempt: ManagedAttempt }
  | { kind: "WorkFrontierClosed" }
  | { kind: "ResultCandidateSubmitted"; product: ResultCandidateProduct }
  | { kind: "TaskReviewPassed"; product: TaskReviewProduct }
  | { kind: "TaskReviewFailed"; product: TaskReviewProduct }
  | { kind: "FeedbackIntentAccepted"; product: FeedbackIntentProduct }
  | { kind: "FeedbackPlanCandidateSubmitted"; product: FeedbackPlanProduct }
  | { kind: "FeedbackPlanningReviewAccepted"; product: FeedbackPlanningAcceptedProduct }
  | { kind: "FinalDossierAccepted"; product: FinalDossierProduct }
  | { kind: "PreparedReportAccepted"; product: PreparedReportProduct }
  | { kind: "DeliveryObserved"; assistantMessageId: string };

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
      successor: "conception_deliberation";
      product: OpeningContinuationProduct;
    }
  | { kind: "submit_goal_candidate"; successor: "contract_review"; product: GoalContractCandidateProduct }
  | { kind: "accept_goal_contract"; successor: "planning"; product: GoalContractAcceptedProduct }
  | { kind: "submit_plan_candidate"; successor: "planning_review"; product: PlanningCandidateProduct }
  | { kind: "accept_plan"; successor: "work_frontier"; product: PlanningAcceptedProduct }
  | { kind: "select_work_task"; successor: "task_execution"; attempt: ManagedAttempt }
  | { kind: "close_work_frontier"; successor: "consolidation" }
  | { kind: "submit_result"; successor: "task_review"; product: ResultCandidateProduct }
  | { kind: "pass_task_review"; successor: "work_frontier"; product: TaskReviewProduct }
  | { kind: "fail_task_review"; successor: "feedback_conception"; product: TaskReviewProduct }
  | { kind: "accept_feedback_intent"; successor: "feedback_planning"; product: FeedbackIntentProduct }
  | { kind: "submit_feedback_plan"; successor: "feedback_planning_review"; product: FeedbackPlanProduct }
  | { kind: "accept_feedback_plan"; successor: "work_frontier"; product: FeedbackPlanningAcceptedProduct }
  | { kind: "accept_final_dossier"; successor: "reporting"; product: FinalDossierProduct }
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

export interface TurnAdmissionRepository {
  recordInbound(input: {
    command: Extract<BtccTurnCommand, { kind: "run" }>;
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
  acquireStateExecutionClaim(turn: TurnRecord): Promise<StateExecutionClaim>;
  commitTransition(input: {
    turn: TurnRecord;
    claim: StateExecutionClaim;
    transition: AcceptedTurnTransition;
  }): Promise<void>;
}

export type { ManagedTurnState } from "./managed-turn-state.ts";
