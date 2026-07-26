import type { Database } from "bun:sqlite";
import type { BtccPersistenceTypes } from "../../../btcc/gateway-api.ts";
import { digest, stableJson } from "./identity.ts";
import { checkpointKind, persistedManagedState } from "./managed-state-projection.ts";

type ManagedTurnState = BtccPersistenceTypes["managedTurnState"];
type TurnRecord = BtccPersistenceTypes["turn"];
type TurnSemanticState = BtccPersistenceTypes["semanticState"];

type ProjectionFields = {
  route?: "managed";
  goalContractRef?: string;
  finalDossierRef?: string;
  finalPayload?: unknown;
  finalDisposition?: "completed" | "deferred";
  outboxId?: string;
};

export class ManagedTurnProjectionWriter {
  constructor(private readonly db: Database) {}

  advance(
    turn: TurnRecord,
    nextRevision: number,
    successor: TurnSemanticState,
    managed: ManagedTurnState,
    fields: ProjectionFields = {},
  ): void {
    const checkpointId = digest(
      `btcc-checkpoint.v1\0${turn.turnId}\0${nextRevision}\0${successor}`,
    );
    const updated = this.db.query(`
      UPDATE btcc_turns SET semantic_state = ?, active_checkpoint_id = ?,
        managed_state_json = ?, revision = ?, route = COALESCE(?, route),
        goal_contract_ref = COALESCE(?, goal_contract_ref),
        final_dossier_ref = COALESCE(?, final_dossier_ref),
        final_payload_json = COALESCE(?, final_payload_json),
        final_disposition = COALESCE(?, final_disposition),
        delivery_outbox_id = COALESCE(?, delivery_outbox_id)
      WHERE turn_id = ? AND revision = ?
    `).run(
      successor,
      checkpointId,
      stableJson(persistedManagedState(managed)),
      nextRevision,
      fields.route ?? null,
      fields.goalContractRef ?? null,
      fields.finalDossierRef ?? null,
      fields.finalPayload ? stableJson(fields.finalPayload) : null,
      fields.finalDisposition ?? null,
      fields.outboxId ?? null,
      turn.turnId,
      turn.revision,
    );
    if (updated.changes !== 1) throw new Error("BTCC managed transition lost Turn CAS");
    this.db.query(`
      INSERT INTO btcc_checkpoints (
        checkpoint_id, turn_id, turn_revision, semantic_state, kind,
        checkpoint_revision, is_active
      ) VALUES (?, ?, ?, ?, ?, 1, 1)
    `).run(checkpointId, turn.turnId, nextRevision, successor, checkpointKind(successor));
  }

  cancelWork(
    turn: TurnRecord,
    nextRevision: number,
    managed: ManagedTurnState,
  ): void {
    const updated = this.db.query(`
      UPDATE btcc_turns SET semantic_state = 'cancelled', active_checkpoint_id = NULL,
        managed_state_json = ?, revision = ?, route = 'managed',
        final_disposition = 'cancelled'
      WHERE turn_id = ? AND revision = ?
    `).run(
      stableJson(persistedManagedState(managed)),
      nextRevision,
      turn.turnId,
      turn.revision,
    );
    if (updated.changes !== 1) throw new Error("BTCC work cancellation lost Turn CAS");
  }
}
