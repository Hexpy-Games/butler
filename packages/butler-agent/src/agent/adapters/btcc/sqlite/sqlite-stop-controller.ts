import type { Database } from "bun:sqlite";
import type {
  ManagedProgramState,
  StopPersistenceOutcome,
} from "../../../btcc/gateway-api.ts";
import { digest } from "./identity.ts";
import {
  StoppedContinuationWriter,
  type StoppedTurnSnapshot,
} from "./stopped-continuation-writer.ts";

type TurnControlRow = StoppedTurnSnapshot & {
  semantic_state: string;
  revision: number;
  canonical_assistant_message_id: string | null;
  final_payload_json: string | null;
  session_id: string;
  context_json: string;
  route: string | null;
};

export type ManagedStopHydration = {
  program: ManagedProgramState;
  expectedRevision: number;
  expectedSemanticState: string;
};

export class ManagedStopPendingPromotionError extends Error {}

export class ManagedStopRevisionChangedError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super("Managed Stop Turn revision changed");
  }
}

export class SqliteStopController {
  constructor(private readonly db: Database) {}

  stop(
    turnId: string,
    hydration?: ManagedStopHydration,
  ): StopPersistenceOutcome {
    return this.db.transaction(() =>
      this.persistStop(turnId, hydration),
    )();
  }

  managedHydrationRequired(turnId: string): boolean {
    const turn = this.db.query<{
      semantic_state: string;
      route: string | null;
      managed_state_json: string | null;
    }, [string]>(`
      SELECT semantic_state, route, managed_state_json
      FROM btcc_turns WHERE turn_id = ?
    `).get(turnId);
    return turn?.route === "managed" &&
      !isTerminalStopState(turn.semantic_state) &&
      hasManagedProgramIdentity(turn.managed_state_json);
  }

  private persistStop(
    turnId: string,
    hydration?: ManagedStopHydration,
  ): StopPersistenceOutcome {
    const turn = this.db.query<TurnControlRow, [string]>(`
      SELECT semantic_state, revision, canonical_assistant_message_id, final_payload_json,
        session_id, context_json, route, managed_state_json, active_checkpoint_id
      FROM btcc_turns WHERE turn_id = ?
    `).get(turnId);
    const stopRequestId = digest(`btcc-stop-request.v1\0${turnId}`);
    if (!turn) {
      this.db.query(`
        INSERT OR IGNORE INTO btcc_stop_requests (
          stop_request_id, turn_id, status, observed_turn_revision, created_at, updated_at
        ) VALUES (?, ?, 'cancelled_before_admission', -1, datetime('now'), datetime('now'))
      `).run(stopRequestId, turnId);
      return { kind: "cancelled", turnId };
    }
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

    if (
      turn.route === "managed" &&
      hasManagedProgramIdentity(turn.managed_state_json)
    ) {
      if (!hydration?.program) {
        throw new Error("Managed Stop requires a canonically hydrated Program");
      }
      if (this.hasPendingProjectPromotion(turnId)) {
        throw new ManagedStopPendingPromotionError(
          "Managed Stop is gated by a pending Project promotion",
        );
      }
      if (turn.revision !== hydration.expectedRevision) {
        throw new ManagedStopRevisionChangedError(
          hydration.expectedRevision,
          turn.revision,
        );
      }
      if (turn.semantic_state !== hydration.expectedSemanticState) {
        throw new Error("Managed Stop semantic state changed without revision");
      }
    }
    const expectedRevision = hydration?.expectedRevision ?? turn.revision;
    const expectedState = hydration?.expectedSemanticState ?? turn.semantic_state;
    const cancelledRevision = expectedRevision + 1;
    const cancelled = this.db.query<{ turn_id: string }, [
      number,
      string,
      number,
      string,
    ]>(`
      UPDATE btcc_turns SET semantic_state = 'cancelled', active_checkpoint_id = NULL,
        revision = ?, execution_fence = execution_fence + 1,
        final_disposition = 'cancelled'
      WHERE turn_id = ? AND revision = ? AND semantic_state = ?
      RETURNING turn_id
    `).get(cancelledRevision, turnId, expectedRevision, expectedState);
    if (cancelled?.turn_id !== turnId) throw new Error("BTCC Stop lost its Turn CAS");
    new StoppedContinuationWriter(this.db).preserve({
      turnId,
      turn,
      program: hydration?.program,
    });
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

  private hasPendingProjectPromotion(turnId: string): boolean {
    return Boolean(this.db.query<{ outbox_id: string }, [string]>(`
      SELECT outbox_id FROM btcc_ledger_promotion_outbox
      WHERE turn_id = ? AND status = 'pending'
    `).get(turnId));
  }

  private closeRequest(id: string, status: string, turnRevision: number): void {
    this.db.query(`
      UPDATE btcc_stop_requests SET status = ?, observed_turn_revision = ?,
        updated_at = datetime('now') WHERE stop_request_id = ?
    `).run(status, turnRevision, id);
  }
}

function isTerminalStopState(state: string): boolean {
  return state === "delivered" || state === "cancelled" ||
    state === "delivery_committed";
}

function hasManagedProgramIdentity(managedStateJson: string | null): boolean {
  if (!managedStateJson) return false;
  try {
    const managed = JSON.parse(managedStateJson) as { programId?: unknown };
    return typeof managed.programId === "string" && managed.programId.length > 0;
  } catch {
    return false;
  }
}
