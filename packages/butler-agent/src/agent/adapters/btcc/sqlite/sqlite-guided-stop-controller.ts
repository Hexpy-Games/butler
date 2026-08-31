import type { Database } from "bun:sqlite";
import type { StopPersistenceOutcome } from
  "../../../btcc/turn/index.ts";
import type { AuthoritySelfSessionCloseCapability } from
  "../../../btcc/authority/index.ts";
import { assertGuidedTurnSemanticState } from "./guided-turn-state.ts";
import { digest } from "./identity.ts";
import { hydrateFinalPayload } from "./sqlite-guided-turn-hydration.ts";

type TurnControlRow = {
  session_id: string;
  semantic_state: string;
  revision: number;
  execution_fence: number;
  canonical_assistant_message_id: string | null;
  final_payload_json: string | null;
};

export class SqliteGuidedStopController {
  constructor(
    private readonly db: Database,
    private readonly authorityClose: AuthoritySelfSessionCloseCapability,
  ) {}

  stop(turnId: string): StopPersistenceOutcome {
    return this.db.transaction(() => this.persistStop(turnId))();
  }

  private persistStop(turnId: string): StopPersistenceOutcome {
    const turn = this.db.query<TurnControlRow, [string]>(`
      SELECT session_id, semantic_state, revision, execution_fence,
        canonical_assistant_message_id, final_payload_json
      FROM btcc_turns WHERE turn_id = ?
    `).get(turnId);
    const stopRequestId = digest(`btcc-stop-request.v1\0${turnId}`);
    if (!turn) {
      this.db.query(`
        INSERT OR IGNORE INTO btcc_stop_requests (
          stop_request_id, turn_id, status, observed_turn_revision,
          created_at, updated_at
        ) VALUES (
          ?, ?, 'cancelled_before_admission', -1, datetime('now'), datetime('now')
        )
      `).run(stopRequestId, turnId);
      return { kind: "cancelled", turnId };
    }
    assertGuidedTurnSemanticState(turn.semantic_state);
    const priorStopStatus = this.db.query<{ status: string }, [string]>(`
      SELECT status FROM btcc_stop_requests WHERE stop_request_id = ?
    `).get(stopRequestId)?.status ?? null;
    this.db.query(`
      INSERT OR IGNORE INTO btcc_stop_requests (
        stop_request_id, turn_id, status, observed_turn_revision,
        created_at, updated_at
      ) VALUES (?, ?, 'installed', ?, datetime('now'), datetime('now'))
    `).run(stopRequestId, turnId, turn.revision);

    if (turn.semantic_state === "delivered") {
      this.closeRequest(stopRequestId, "already_delivered", turn.revision);
      const finalPayload = hydrateFinalPayload(turn.final_payload_json);
      if (!finalPayload) {
        throw new Error("Delivered BTCC R3 Turn has no final payload");
      }
      if (!turn.canonical_assistant_message_id) {
        throw new Error("Delivered BTCC R3 Turn has no canonical message");
      }
      return {
        kind: "already_delivered",
        turnId,
        messageId: turn.canonical_assistant_message_id,
        content: finalPayload.content,
        ...(finalPayload.workStatus
          ? { workStatus: finalPayload.workStatus }
          : {}),
        ...(finalPayload.artifacts?.length
          ? { artifacts: finalPayload.artifacts }
          : {}),
        ...(finalPayload.changedFiles?.length
          ? { changedFiles: finalPayload.changedFiles }
          : {}),
      };
    }
    if (turn.semantic_state === "cancelled") {
      // A terminal pre-existing stop-request proves the original
      // operational close already committed; replaying it again would
      // close a newer same-session request, so only an absent (legacy
      // cancelled Turn) or still-installed row may re-close.
      this.closeRequest(stopRequestId, "already_cancelled", turn.revision);
      if (priorStopStatus === null || priorStopStatus === "installed") {
        this.closeSelfSessionRequests(turn.session_id);
      }
      return { kind: "already_cancelled", turnId };
    }
    if (turn.semantic_state === "delivery_committed") {
      this.closeRequest(stopRequestId, "already_finalizing", turn.revision);
      return { kind: "already_finalizing", turnId };
    }

    const cancelledRevision = turn.revision + 1;
    const cancelled = this.db.query<{ turn_id: string }, [
      number,
      string,
      number,
      number,
    ]>(`
      UPDATE btcc_turns SET semantic_state = 'cancelled',
        active_checkpoint_id = NULL, revision = ?,
        execution_fence = execution_fence + 1,
        final_disposition = 'cancelled'
      WHERE turn_id = ? AND revision = ? AND semantic_state = 'admitted'
        AND execution_fence = ?
      RETURNING turn_id
    `).get(
      cancelledRevision,
      turnId,
      turn.revision,
      turn.execution_fence,
    );
    if (cancelled?.turn_id !== turnId) {
      throw new Error("BTCC R3 Stop lost its Turn CAS");
    }
    this.db.query(`
      UPDATE btcc_checkpoints SET is_active = 0, active_claim_id = NULL
      WHERE turn_id = ? AND is_active = 1
    `).run(turnId);
    this.db.query(`
      UPDATE btcc_state_claims SET status = 'revoked'
      WHERE turn_id = ? AND status = 'active'
    `).run(turnId);
    this.closeRequest(stopRequestId, "cancelled", cancelledRevision);
    this.closeSelfSessionRequests(turn.session_id);
    return { kind: "cancelled", turnId };
  }

  private closeSelfSessionRequests(selfSessionId: string): void {
    this.authorityClose.closeSelfSession({
      selfSessionId,
      reason: "session_cancelled",
    });
  }

  private closeRequest(
    stopRequestId: string,
    status: string,
    turnRevision: number,
  ): void {
    this.db.query(`
      UPDATE btcc_stop_requests SET status = ?, observed_turn_revision = ?,
        updated_at = datetime('now') WHERE stop_request_id = ?
    `).run(status, turnRevision, stopRequestId);
  }
}
