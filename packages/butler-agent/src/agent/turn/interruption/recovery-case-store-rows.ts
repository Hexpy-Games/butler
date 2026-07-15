import { TURN_RECOVERY_CASE_SCHEMA } from "./turn-interruption-types.ts";
import type {
  BtccTurnState,
  BtccTurnStateRecord,
  RecoveryCaseV1,
} from "./turn-interruption-types.ts";

export interface TurnStateRow {
  turn_id: string;
  session_id: string;
  attempt_id: string;
  state: BtccTurnState;
  generation: number;
  last_stable_checkpoint_ref: string | null;
  active_recovery_case_id: string | null;
  active_wait_owner_ref: string | null;
  active_wake_revision_ref: string | null;
  terminal_outcome_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecoveryCaseRow {
  recovery_case_id: string;
  turn_id: string;
  attempt_id: string;
  interruption_id: string;
  origin: RecoveryCaseV1["origin"];
  diagnostic_code: RecoveryCaseV1["diagnosticCode"];
  last_stable_checkpoint_ref: string;
  pending_operation_ref: string | null;
  side_effect_state: RecoveryCaseV1["sideEffectState"];
  owner: RecoveryCaseV1["owner"];
  resume_predicate_ref: string;
  wake_revision_ref: string | null;
  progress_fingerprint: string;
  diagnostic_refs_json: string;
  public_status_id: string;
  available_control_refs_json: string;
  status: RecoveryCaseV1["status"];
  created_at: string;
}

export function hydrateTurnState(row: TurnStateRow): BtccTurnStateRecord {
  return {
    turnId: row.turn_id,
    sessionId: row.session_id,
    attemptId: row.attempt_id,
    state: row.state,
    generation: row.generation,
    ...(row.last_stable_checkpoint_ref
      ? { lastStableCheckpointRef: row.last_stable_checkpoint_ref }
      : {}),
    ...(row.active_recovery_case_id
      ? { activeRecoveryCaseId: row.active_recovery_case_id }
      : {}),
    ...(row.active_wait_owner_ref
      ? { activeWaitOwnerRef: row.active_wait_owner_ref }
      : {}),
    ...(row.active_wake_revision_ref
      ? { activeWakeRevisionRef: row.active_wake_revision_ref }
      : {}),
    ...(row.terminal_outcome_id
      ? { terminalOutcomeId: row.terminal_outcome_id }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function hydrateRecoveryCase(row: RecoveryCaseRow): RecoveryCaseV1 {
  return {
    schemaVersion: TURN_RECOVERY_CASE_SCHEMA,
    recoveryCaseId: row.recovery_case_id,
    turnId: row.turn_id,
    attemptId: row.attempt_id,
    interruptionId: row.interruption_id,
    origin: row.origin,
    diagnosticCode: row.diagnostic_code,
    lastStableCheckpointRef: row.last_stable_checkpoint_ref,
    ...(row.pending_operation_ref
      ? { pendingOperationRef: row.pending_operation_ref }
      : {}),
    sideEffectState: row.side_effect_state,
    owner: row.owner,
    resumePredicateRef: row.resume_predicate_ref,
    ...(row.wake_revision_ref ? { wakeRevisionRef: row.wake_revision_ref } : {}),
    progressFingerprint: row.progress_fingerprint,
    diagnosticRefs: parseRefs(row.diagnostic_refs_json),
    publicStatusId: row.public_status_id,
    availableControlRefs: parseRefs(row.available_control_refs_json),
    status: row.status,
    createdAt: row.created_at,
  };
}

function parseRefs(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}
