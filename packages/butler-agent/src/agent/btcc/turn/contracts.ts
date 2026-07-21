import type {
  AdmittedModelSelection,
  BtccTurnCommand,
  ButlerContextInput,
} from "../contracts.ts";
import type { OpeningAnswerProduct } from "../conception/index.ts";

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
  route?: "direct";
  openingAnswer?: OpeningAnswerProduct;
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
