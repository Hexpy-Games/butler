import type {
  AdmittedModelSelection,
  ButlerContextInput,
  BtccProgressDestination,
  BtccFinalArtifact,
  FreshBtccTurnCommand,
} from "../contracts.ts";
import type {
  ModelRouteAttemptHistory,
  ModelRouteEventResult,
  ModelRouteState,
} from "../model-route/index.ts";
import type { ContentRef } from "../identity/index.ts";

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
  wakeIdentity?: {
    triggerId: string;
    sourceTurnId: string;
    authorizationRef: string;
    resultScopeRef?: string;
  };
  modelSelection: AdmittedModelSelection;
  modelRoute?: ModelRouteState;
  context: ButlerContextInput;
  progressDestination?: BtccProgressDestination;
  semanticState: TurnSemanticState;
  checkpoint?: TurnCheckpoint;
  route?: "direct" | "assisted" | "managed";
  finalPayload?: {
    ref: ContentRef;
    content: string;
    contentSha256: string;
    artifacts?: BtccFinalArtifact[];
    modelIdentity?: {
      requestedModelRef: string;
      effectiveModelRef: string;
      providerReportedModelRef?: string;
    };
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

export type BtccWakeAuthorization = {
  sourceTurnId: string;
  authorizationRef: string;
  resultScopeRef?: string;
};

export interface BtccWakeAuthorizationReader {
  validateWake(input: BtccWakeAuthorization): boolean | Promise<boolean>;
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
  persistModelRoute?(input: {
    turnId: string;
    expectedRevision: number;
    executionFence: number;
    claimId: string;
    route: ModelRouteState;
  }): Promise<void>;
  recordModelRouteEvent?(input: {
    turnId: string;
    expectedRevision: number;
    executionFence: number;
    claimId: string;
    event: {
      type: string;
      roundId: string;
      candidateIndex: number;
      transportAttempt?: number;
      modelRef: string;
      errorCode?: string;
      failureDisposition?: import("../model-route/index.ts").ModelRouteFailureDisposition;
    };
    route?: ModelRouteState;
  }): Promise<ModelRouteEventResult | void>;
  loadModelRouteAttemptHistory?(input: {
    turnId: string;
    roundId: string;
    routeDigest: string;
    candidateIndex: number;
    modelRef: string;
  }): Promise<ModelRouteAttemptHistory>;
  loadModelRoundAcceptance?(input: {
    turnId: string;
    roundId: string;
    routeDigest: string;
    candidateIndex: number;
    modelRef: string;
    checkpointId: string;
    checkpointRevision: number;
  }): Promise<import("../ports/model-round.ts").ModelRoundResult | undefined>;
  recordModelRoundAcceptance?(input: {
    turnId: string;
    expectedRevision: number;
    executionFence: number;
    claimId: string;
    checkpointId: string;
    checkpointRevision: number;
    roundId: string;
    routeDigest: string;
    candidateIndex: number;
    transportAttempt: number;
    modelRef: string;
    result: import("../ports/model-round.ts").ModelRoundResult;
  }): Promise<void>;
  stopTurn(turnId: string): Promise<StopPersistenceOutcome>;
}

export type StopPersistenceOutcome =
  | { kind: "cancelled"; turnId: string }
  | { kind: "already_cancelled"; turnId: string }
  | { kind: "already_finalizing"; turnId: string }
  | {
      kind: "already_delivered";
      turnId: string;
      messageId: string;
      content: string;
      artifacts?: BtccFinalArtifact[];
    };
