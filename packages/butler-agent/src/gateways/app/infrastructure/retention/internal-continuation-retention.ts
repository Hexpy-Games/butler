import type { Database } from "bun:sqlite";
import {
  isRecord,
  safeOptionalShortToken,
} from "../core/projection-safe-values.ts";
import { isInternalContinuationProgressEvent } from
  "../../domain/progress-summary/public-progress-rows.ts";

const MARKER_DELETE_BATCH = 64;

export class InternalContinuationRetention {
  constructor(private readonly db: Database) {}

  rememberSource(turnId: string, payload: Record<string, unknown>): void {
    if (payload.turn_id !== turnId) return;
    const event = isRecord(payload.event) ? payload.event : null;
    const eventId = safeOptionalShortToken(event?.id);
    if (!eventId || !isInternalContinuationProgressEvent(event)) return;
    this.db.query(`
      INSERT OR IGNORE INTO app_internal_continuation_progress_events (
        turn_id, event_id
      ) VALUES (?, ?)
    `).run(turnId, eventId);
  }

  retainInternalProgress(
    turnId: string,
    payload: Record<string, unknown>,
    sourceEventId: number,
  ): boolean {
    const eventId = safeOptionalShortToken(payload.event_id);
    if (!eventId) return false;
    const retained = Boolean(this.db.query<
      { found: number },
      [string, string]
    >(`
      SELECT 1 AS found FROM app_internal_continuation_progress_events
      WHERE turn_id = ? AND event_id = ?
    `).get(turnId, eventId));
    if (!retained) return false;
    this.db.query(`
      UPDATE app_internal_continuation_progress_events
      SET source_event_id = ? WHERE turn_id = ? AND event_id = ?
    `).run(sourceEventId, turnId, eventId);
    this.db.query(`
      INSERT OR REPLACE INTO app_terminal_turn_progress_rows (
        turn_id, source_event_id, row_json
      ) VALUES (?, ?, ?)
    `).run(turnId, sourceEventId, JSON.stringify({
      id: `internal-continuation-${sourceEventId}`,
      kind: "thinking",
      safe_label: "Internal continuation",
      state: "running",
    }));
    return true;
  }

  clearBatch(turnId: string): boolean {
    this.db.transaction(() => {
      this.db.query(`
        DELETE FROM app_terminal_turn_progress_rows
        WHERE turn_id = ? AND source_event_id IN (
          SELECT source_event_id FROM app_internal_continuation_progress_events
          WHERE turn_id = ? LIMIT ${MARKER_DELETE_BATCH}
        )
      `).run(turnId, turnId);
      this.db.query(`
        DELETE FROM app_internal_continuation_progress_events
        WHERE turn_id = ? AND event_id IN (
          SELECT event_id FROM app_internal_continuation_progress_events
          WHERE turn_id = ? LIMIT ${MARKER_DELETE_BATCH}
        )
      `).run(turnId, turnId);
    })();
    return Boolean(this.db.query<{ found: number }, [string]>(`
      SELECT 1 AS found FROM app_internal_continuation_progress_events
      WHERE turn_id = ? LIMIT 1
    `).get(turnId));
  }
}
