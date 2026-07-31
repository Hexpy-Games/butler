import type {
  AdmittedModelSelection,
  ButlerContextInput,
  FreshBtccTurnCommand,
} from "../contracts.ts";
import type { ContentRef } from "../identity.ts";

export type TurnSemanticState =
  | "admitted"
  | "delivery_committed"
  | "delivered"
  | "cancelled";

export type TurnCheckpoint = {
  checkpointId: string;
  checkpointRevision: number;
  kind: "runtime";
  semanticState: TurnSemanticState;
};

export type DeliveryOutbox = {
  outboxId: string;
  finalPayloadRef: ContentRef;
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
  route?: "direct" | "assisted" | "managed";
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

export type AcceptedTurnTransition =
  | {
      kind: "accept_guided_final";
      successor: "delivery_committed";
      successorCheckpointKind: "runtime";
      route: "direct" | "assisted" | "managed";
      finalPayload: NonNullable<TurnRecord["finalPayload"]>;
      deliveryOutbox: DeliveryOutbox;
    }
  | {
      kind: "observe_delivery";
      successor: "delivered";
      assistantMessageId: string;
    };

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
