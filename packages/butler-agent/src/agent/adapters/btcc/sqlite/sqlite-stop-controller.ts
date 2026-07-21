import type { Database } from "bun:sqlite";
import type { StopPersistenceOutcome } from "../../../btcc/gateway-api.ts";
import { digest } from "./identity.ts";

type TurnControlRow = {
  semantic_state: string;
  revision: number;
  canonical_assistant_message_id: string | null;
  final_payload_json: string | null;
};

export class SqliteStopController {
  constructor(private readonly db: Database) {}

  stop(turnId: string): StopPersistenceOutcome {
    return this.db.transaction(() => this.persistStop(turnId))();
  }

  private persistStop(turnId: string): StopPersistenceOutcome {
    const turn = this.db.query<TurnControlRow, [string]>(`
      SELECT semantic_state, revision, canonical_assistant_message_id, final_payload_json
      FROM btcc_turns WHERE turn_id = ?
    `).get(turnId);
    if (!turn) throw new Error(`BTCC Stop target does not exist: ${turnId}`);
    const stopRequestId = digest(`btcc-stop-request.v1\0${turnId}`);
    this.db.query(`
      INSERT OR IGNORE INTO btcc_stop_requests (
        stop_request_id, turn_id, status, observed_turn_revision, created_at, updated_at
      ) VALUES (?, ?, 'installed', ?, datetime('now'), datetime('now'))
    `).run(stopRequestId, turnId, turn.revision);

    if (turn.semantic_state === "delivered") {
      this.closeRequest(stopRequestId, "already_delivered", turn.revision);
      const payload = turn.final_payload_json ? JSON.parse(turn.final_payload_json) : null;
      if (!turn.canonical_assistant_message_id || typeof payload?.content !== "string") {
        throw new Error("Delivered BTCC Turn is missing its canonical payload");
      }
      return {
        kind: "already_delivered",
        turnId,
        messageId: turn.canonical_assistant_message_id,
        content: payload.content,
      };
    }
    if (turn.semantic_state === "cancelled") {
      this.closeRequest(stopRequestId, "already_cancelled", turn.revision);
      return { kind: "already_cancelled", turnId };
    }
    if (turn.semantic_state === "delivery_committed") {
      this.closeRequest(stopRequestId, "already_finalizing", turn.revision);
      return { kind: "already_finalizing", turnId };
    }

    const cancelledRevision = turn.revision + 1;
    const cancelled = this.db.query(`
      UPDATE btcc_turns SET semantic_state = 'cancelled', active_checkpoint_id = NULL,
        revision = ?, execution_fence = execution_fence + 1,
        final_disposition = 'cancelled'
      WHERE turn_id = ? AND revision = ? AND semantic_state = ?
    `).run(cancelledRevision, turnId, turn.revision, turn.semantic_state);
    if (cancelled.changes !== 1) throw new Error("BTCC Stop lost its Turn CAS");
    this.db.query(`
      UPDATE btcc_checkpoints SET is_active = 0, active_claim_id = NULL
      WHERE turn_id = ? AND is_active = 1
    `).run(turnId);
    this.db.query(`
      UPDATE btcc_state_claims SET status = 'revoked'
      WHERE turn_id = ? AND status = 'active'
    `).run(turnId);
    this.closeRequest(stopRequestId, "cancelled", cancelledRevision);
    return { kind: "cancelled", turnId };
  }

  private closeRequest(id: string, status: string, turnRevision: number): void {
    this.db.query(`
      UPDATE btcc_stop_requests SET status = ?, observed_turn_revision = ?,
        updated_at = datetime('now') WHERE stop_request_id = ?
    `).run(status, turnRevision, id);
  }
}
