import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type {
  StewardObserverRelation,
  StewardObserverTurn,
} from "../../../../gateways/app/domain/sessions/steward-observer.ts";
import type {
  ProcessLiveness,
  RuntimeOwnerIdentity,
} from "./runtime-owner/index.ts";

export type StewardRecoveryTurnRow = {
  turn_id: string;
  semantic_state: string;
  trigger_key: string;
  original_message_id: string;
  original_message: string;
  created_at: string;
  claim_id: string | null;
  claim_status: string | null;
  owner_id: string | null;
  owner_generation: number | null;
  lease_generation: number | null;
  owner_host_id: string | null;
  owner_process_id: number | null;
  owner_process_started_at_ms: number | null;
  owner_status: string | null;
};

export type RecoverableStewardTurn = {
  relation: StewardObserverRelation;
  turn_id: string;
  recovery_id: string;
  original_event_id: string;
  original_message_id: string;
  original_message: string;
};

type RecoveryCandidateRow = StewardRecoveryTurnRow & StewardObserverRelation;

export function projectStewardTurnRecovery(
  turn: StewardRecoveryTurnRow,
  processLiveness: ProcessLiveness,
): NonNullable<StewardObserverTurn["recovery"]> {
  if (!turn.claim_id) return { state: "unknown" };
  const recoveryId = createHash("sha256").update([
    "btcc.steward-recovery.v1",
    turn.turn_id,
    turn.claim_id,
    String(turn.owner_generation ?? ""),
    String(turn.lease_generation ?? ""),
  ].join("\0")).digest("hex").slice(0, 32);
  if (turn.claim_status !== "active" || turn.owner_status === "terminated" ||
    turn.owner_status === "closed") {
    return { state: "recoverable", recovery_id: recoveryId };
  }
  const identity = ownerIdentity(turn);
  if (!identity) return { state: "unknown" };
  return processLiveness.isAlive(identity)
    ? { state: "live" }
    : { state: "recoverable", recovery_id: recoveryId };
}

export function readRecoverableStewardTurns(
  db: Database,
  processLiveness: ProcessLiveness,
): RecoverableStewardTurn[] {
  return db.query<RecoveryCandidateRow, []>(`
    SELECT relation.relation_id, relation.parent_session_id,
      relation.parent_turn_id, relation.child_session_id,
      relation.anchor_message_id, relation.ordinal, relation.safe_title,
      relation.created_at, turn.turn_id, turn.semantic_state,
      turn.trigger_key, turn.original_message_id, turn.original_message,
      claim.claim_id, claim.status AS claim_status, claim.owner_id,
      claim.owner_generation, claim.lease_generation,
      owner.host_id AS owner_host_id, owner.process_id AS owner_process_id,
      owner.process_started_at_ms AS owner_process_started_at_ms,
      owner.status AS owner_status
    FROM btcc_session_relations AS relation
    JOIN btcc_turns AS turn ON turn.session_id = relation.child_session_id
    LEFT JOIN btcc_checkpoints AS checkpoint
      ON checkpoint.checkpoint_id = turn.active_checkpoint_id
     AND checkpoint.is_active = 1
    LEFT JOIN btcc_state_claims AS claim
      ON claim.claim_id = checkpoint.active_claim_id
    LEFT JOIN btcc_runtime_owners AS owner ON owner.owner_id = claim.owner_id
    WHERE turn.semantic_state = 'admitted'
      AND NOT EXISTS (
        SELECT 1 FROM btcc_turns AS newer
        WHERE newer.session_id = turn.session_id AND newer.rowid > turn.rowid
      )
      AND NOT EXISTS (
        SELECT 1 FROM btcc_steward_results AS result
        WHERE result.relation_id = relation.relation_id
      )
    ORDER BY relation.created_at ASC, relation.relation_id ASC
  `).all().flatMap((row) => {
    const recovery = projectStewardTurnRecovery(row, processLiveness);
    return recovery.state === "recoverable" && recovery.recovery_id
      ? [{
          relation: {
            relation_id: row.relation_id,
            parent_session_id: row.parent_session_id,
            parent_turn_id: row.parent_turn_id,
            child_session_id: row.child_session_id,
            anchor_message_id: row.anchor_message_id,
            ordinal: row.ordinal,
            safe_title: row.safe_title,
            created_at: row.created_at,
          },
          turn_id: row.turn_id,
          recovery_id: recovery.recovery_id,
          original_event_id: row.trigger_key,
          original_message_id: row.original_message_id,
          original_message: row.original_message,
        }]
      : [];
  });
}

function ownerIdentity(turn: StewardRecoveryTurnRow): RuntimeOwnerIdentity | null {
  if (!turn.owner_id || !turn.owner_host_id ||
    !Number.isInteger(turn.owner_process_id) ||
    !Number.isFinite(turn.owner_process_started_at_ms)) return null;
  return {
    ownerId: turn.owner_id,
    hostId: turn.owner_host_id,
    processId: turn.owner_process_id!,
    processStartedAtMs: turn.owner_process_started_at_ms!,
  };
}
