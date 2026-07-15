import type { TurnInterruptionOrigin } from "./turn-interruption-producer-registry.ts";

export const TURN_INTERRUPTION_ENVELOPE_SCHEMA =
  "butler.turn-interruption-envelope.v1" as const;
export const TURN_INTERRUPTION_RECEIPT_SCHEMA =
  "butler.turn-interruption-receipt.v1" as const;
export const TURN_RECOVERY_CASE_SCHEMA = "butler.turn-recovery-case.v1" as const;

export const RUNTIME_INTERRUPTION_CODES = [
  "runtime_process_crash",
  "provider_stream_corruption",
  "storage_invariant_violation",
  "api_protocol_invariant_violation",
  "queue_claim_invariant_violation",
  "compaction_invariant_violation",
  "phase_input_contract_oversize",
  "runtime_unclassified_interruption",
] as const;

export const BTCC_TURN_STATES = [
  "accepted",
  "model_deciding",
  "announcing_intent",
  "executing_tools",
  "observing_tools",
  "continuing",
  "waiting_user",
  "waiting_external",
  "waiting_runtime",
  "delivered",
  "cancelled",
] as const;

export type BtccTurnState = (typeof BTCC_TURN_STATES)[number];
export type BtccTerminalTurnState = "delivered" | "cancelled";
export type SideEffectState =
  | "none"
  | "known_applied"
  | "known_not_applied"
  | "indeterminate";
export type RuntimeInterruptionCode = (typeof RUNTIME_INTERRUPTION_CODES)[number];

interface TurnInterruptionEnvelopeBase {
  schemaVersion: typeof TURN_INTERRUPTION_ENVELOPE_SCHEMA;
  interruptionId: string;
  turnId: string;
  attemptId: string;
  origin: TurnInterruptionOrigin;
  currentGeneration: number;
  lastStableCheckpointRef: string;
  createdAt: string;
}

export interface InternalIncompletionEnvelope extends TurnInterruptionEnvelopeBase {
  kind: "internal_incompletion";
  continuationCheckpointRef: string;
}

export interface UserAuthorityWaitEnvelope extends TurnInterruptionEnvelopeBase {
  kind: "user_authority_required";
  ownerRef: string;
}

export interface ExternalAuthorityWaitEnvelope extends TurnInterruptionEnvelopeBase {
  kind: "external_authority_required";
  ownerRef: string;
  wakeRevisionRef: string;
}

export interface RuntimeInterruptionEnvelope extends TurnInterruptionEnvelopeBase {
  kind: "runtime_interruption";
  diagnosticCode?: RuntimeInterruptionCode;
  pendingOperationRef?: string;
  sideEffectState: SideEffectState;
  resumePredicateRef: string;
  wakeRevisionRef?: string;
  diagnosticRefs: string[];
  publicStatusId?: string;
  availableControlRefs?: string[];
}

export interface UserCancellationEnvelope extends TurnInterruptionEnvelopeBase {
  kind: "user_cancellation";
  cancellationGeneration: number;
  cancellationReceiptRef: string;
}

export type TurnInterruptionEnvelope =
  | InternalIncompletionEnvelope
  | UserAuthorityWaitEnvelope
  | ExternalAuthorityWaitEnvelope
  | RuntimeInterruptionEnvelope
  | UserCancellationEnvelope;

export interface TurnInterruptionReceiptV1 {
  schemaVersion: typeof TURN_INTERRUPTION_RECEIPT_SCHEMA;
  interruptionId: string;
  turnId: string;
  attemptId: string;
  origin: TurnInterruptionOrigin;
  diagnosticCode: RuntimeInterruptionCode;
  lastStableCheckpointRef: string;
  pendingOperationRef?: string;
  sideEffectState: SideEffectState;
  resumePredicateRef: string;
  wakeRevisionRef?: string;
  progressFingerprint: string;
  diagnosticRefs: string[];
  createdAt: string;
}

export interface RecoveryCaseV1 {
  schemaVersion: typeof TURN_RECOVERY_CASE_SCHEMA;
  recoveryCaseId: string;
  turnId: string;
  attemptId: string;
  interruptionId: string;
  origin: TurnInterruptionOrigin;
  diagnosticCode: RuntimeInterruptionCode;
  lastStableCheckpointRef: string;
  pendingOperationRef?: string;
  sideEffectState: SideEffectState;
  owner: "turn_runtime_recovery";
  resumePredicateRef: string;
  wakeRevisionRef?: string;
  progressFingerprint: string;
  diagnosticRefs: string[];
  publicStatusId: string;
  availableControlRefs: string[];
  status: "open" | "resolved" | "cancelled";
  createdAt: string;
}

export type TurnInterruptionDirective =
  | {
    kind: "continue_same_turn";
    turnId: string;
    attemptId: string;
    expectedGeneration: number;
    checkpointRef: string;
  }
  | {
    kind: "waiting_user";
    turnId: string;
    attemptId: string;
    expectedGeneration: number;
    checkpointRef: string;
    ownerRef: string;
  }
  | {
    kind: "waiting_external";
    turnId: string;
    attemptId: string;
    expectedGeneration: number;
    checkpointRef: string;
    ownerRef: string;
    wakeRevisionRef: string;
  }
  | {
    kind: "waiting_runtime";
    turnId: string;
    attemptId: string;
    expectedGeneration: number;
    checkpointRef: string;
    interruptionReceipt: TurnInterruptionReceiptV1;
    recoveryCase: RecoveryCaseV1;
  }
  | {
    kind: "cancelled";
    turnId: string;
    attemptId: string;
    expectedGeneration: number;
    checkpointRef: string;
    cancellationReceiptRef: string;
  };

export interface BtccTurnStateRecord {
  turnId: string;
  sessionId: string;
  attemptId: string;
  state: BtccTurnState;
  generation: number;
  lastStableCheckpointRef?: string;
  activeRecoveryCaseId?: string;
  activeWaitOwnerRef?: string;
  activeWakeRevisionRef?: string;
  terminalOutcomeId?: string;
  createdAt: string;
  updatedAt: string;
}
