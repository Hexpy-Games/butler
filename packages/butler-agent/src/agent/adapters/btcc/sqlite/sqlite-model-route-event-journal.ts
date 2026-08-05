import type { Database } from "bun:sqlite";
import type {
  ModelRouteAttemptHistory,
  ModelRouteEventResult,
  ModelRouteState,
} from "../../../btcc/model-route/index.ts";
import type {
  SqliteModelRouteAttemptHistoryInput,
  SqliteModelRouteEventInput,
} from "./sqlite-model-route-types.ts";

export class SqliteModelRouteEventJournal {
  constructor(private readonly db: Database) {}

  async persistModelRoute(input: {
    turnId: string;
    expectedRevision: number;
    executionFence: number;
    claimId: string;
    route: ModelRouteState;
  }): Promise<void> {
    await this.recordModelRouteEvent({
      turnId: input.turnId,
      expectedRevision: input.expectedRevision,
      executionFence: input.executionFence,
      claimId: input.claimId,
      route: input.route,
      event: {
        type: "model.route.updated",
        roundId: "route-state",
        candidateIndex: input.route.activeCursor,
        modelRef: input.route.candidates[input.route.activeCursor]?.modelRef ?? "unknown",
      },
    });
  }

  async recordModelRouteEvent(
    input: SqliteModelRouteEventInput,
  ): Promise<ModelRouteEventResult> {
    return this.db.transaction((): ModelRouteEventResult => {
      this.assertTurnClaim(input);
      const routeJson = this.db.query<{ route_state_json: string | null }, [string]>(
        "SELECT route_state_json FROM btcc_turns WHERE turn_id = ?",
      ).get(input.turnId)?.route_state_json;
      const routeDigest = input.route?.routeDigest ??
        (routeJson ? JSON.parse(routeJson).routeDigest : "unknown");
      const eventId = `${input.turnId}:${input.event.type}:${input.event.roundId}:${input.event.candidateIndex}:${input.event.transportAttempt ?? 0}:${input.event.modelRef}`;
      if (input.event.type === "model.attempt.started") {
        const existing = this.db.query<{ event_type: string }, [string]>(`
          SELECT event_type FROM btcc_model_route_events WHERE event_id = ?
        `).get(eventId);
        if (existing) {
          const terminal = this.db.query<{ event_type: string }, [string, string, number, number, string]>(`
            SELECT event_type FROM btcc_model_route_events
            WHERE turn_id = ? AND round_id = ? AND candidate_index = ?
              AND transport_attempt = ? AND model_ref = ?
              AND event_type IN (
                'model.attempt.failed',
                'model.attempt.succeeded',
                'model.attempt.abandoned_after_restart'
              )
            ORDER BY created_at DESC LIMIT 1
          `).get(
            input.turnId,
            input.event.roundId,
            input.event.candidateIndex,
            input.event.transportAttempt ?? 0,
            input.event.modelRef,
          );
          if (terminal?.event_type === "model.attempt.abandoned_after_restart") {
            return { status: "abandoned_after_restart" };
          }
          if (terminal) return { status: "already_terminal" };
          this.db.query(`
            INSERT OR IGNORE INTO btcc_model_route_events (
              event_id, turn_id, route_digest, event_type, round_id,
              candidate_index, transport_attempt, model_ref, error_code,
              failure_disposition, created_at
            ) VALUES (?, ?, ?, 'model.attempt.abandoned_after_restart', ?, ?, ?, ?, NULL, NULL, ?)
          `).run(
            `${eventId}:abandoned_after_restart`,
            input.turnId,
            routeDigest,
            input.event.roundId,
            input.event.candidateIndex,
            input.event.transportAttempt ?? null,
            input.event.modelRef,
            new Date().toISOString(),
          );
          return { status: "abandoned_after_restart" };
        }
      }
      this.db.query(`
        INSERT OR IGNORE INTO btcc_model_route_events (
          event_id, turn_id, route_digest, event_type, round_id,
          candidate_index, transport_attempt, model_ref, error_code,
          failure_disposition, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventId,
        input.turnId,
        routeDigest,
        input.event.type,
        input.event.roundId,
        input.event.candidateIndex,
        input.event.transportAttempt ?? null,
        input.event.modelRef,
        input.event.errorCode ?? null,
        input.event.failureDisposition ?? null,
        new Date().toISOString(),
      );
      if (input.route) {
        const updated = this.db.query(`
          UPDATE btcc_turns SET route_state_json = ?
          WHERE turn_id = ? AND revision = ? AND execution_fence = ?
        `).run(JSON.stringify(input.route), input.turnId, input.expectedRevision, input.executionFence);
        if (updated.changes !== 1) throw new Error("BTCC model route persistence lost Turn CAS");
      }
      return { status: "recorded" };
    })();
  }

  async loadModelRouteAttemptHistory(
    input: SqliteModelRouteAttemptHistoryInput,
  ): Promise<ModelRouteAttemptHistory> {
    const rows = this.db.query<{
      event_type: string;
      transport_attempt: number | null;
      error_code: string | null;
      failure_disposition: string | null;
    }, [string, string, string, number, string]>(`
      SELECT event_type, transport_attempt, error_code, failure_disposition
      FROM btcc_model_route_events
      WHERE turn_id = ? AND route_digest = ? AND round_id = ?
        AND candidate_index = ? AND model_ref = ?
        AND transport_attempt IS NOT NULL
      ORDER BY transport_attempt ASC, created_at ASC
    `).all(
      input.turnId,
      input.routeDigest,
      input.roundId,
      input.candidateIndex,
      input.modelRef,
    );
    const started: number[] = [];
    const failed: number[] = [];
    const failedDetails: NonNullable<ModelRouteAttemptHistory["failedDetails"]>[number][] = [];
    const succeeded: number[] = [];
    const abandoned: number[] = [];
    for (const row of rows) {
      if (row.transport_attempt === null) continue;
      if (row.event_type === "model.attempt.started") started.push(row.transport_attempt);
      if (row.event_type === "model.attempt.failed") {
        failed.push(row.transport_attempt);
        if (isFailureDisposition(row.failure_disposition)) {
          failedDetails.push({
            transportAttempt: row.transport_attempt,
            errorCode: row.error_code ?? "provider_unknown_error",
            disposition: row.failure_disposition,
          });
        }
      }
      if (row.event_type === "model.attempt.succeeded") succeeded.push(row.transport_attempt);
      if (row.event_type === "model.attempt.abandoned_after_restart") abandoned.push(row.transport_attempt);
    }
    return {
      started,
      failed,
      ...(failedDetails.length > 0 ? { failedDetails } : {}),
      succeeded,
      abandoned,
    };
  }

  private assertTurnClaim(input: SqliteModelRouteEventInput): void {
    const claim = this.db.query<{
      turn_id: string;
      turn_revision: number;
      execution_fence: number;
      status: string;
    }, [string]>(`
      SELECT turn_id, turn_revision, execution_fence, status
      FROM btcc_state_claims WHERE claim_id = ?
    `).get(input.claimId);
    const current = this.db.query<{
      revision: number;
      execution_fence: number;
      semantic_state: string;
    }, [string]>(`
      SELECT revision, execution_fence, semantic_state
      FROM btcc_turns WHERE turn_id = ?
    `).get(input.turnId);
    if (!claim || !current || claim.turn_id !== input.turnId ||
        claim.turn_revision !== input.expectedRevision ||
        claim.execution_fence !== input.executionFence || claim.status !== "active" ||
        current.revision !== input.expectedRevision ||
        current.execution_fence !== input.executionFence ||
        current.semantic_state === "delivered" || current.semantic_state === "cancelled") {
      throw new Error("BTCC model route event lost exact Turn claim");
    }
  }
}

function isFailureDisposition(
  value: string | null,
): value is NonNullable<ModelRouteAttemptHistory["failedDetails"]>[number]["disposition"] {
  return value === "retry" || value === "advance" || value === "surface";
}
