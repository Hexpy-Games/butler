import { Database } from "bun:sqlite";
import type { EventRow, TurnRow } from "../../infrastructure/core/records.ts";
import {
  isRecord,
  safeOptionalShortToken,
  safeParseRecord,
} from "../../infrastructure/core/projection-safe-values.ts";
import {
  isInternalContinuationProgressEvent,
  publicProgressRowsForTurn,
} from "../progress-summary/public-progress-rows.ts";
import { normalizeProgressSummaryRow } from "../progress-summary/progress-row-normalizer.ts";
import type { ProgressSummaryRow } from "../../interface/protocol/app-protocol.ts";

export function hasPublicContinuationProgressSinceLatestQueue(input: {
  db: Database;
  getTurnRow: (turnId: string) => TurnRow | null;
  turnId: string;
}): boolean {
  const latestQueue = input.db
    .query<{ id: number }, [string]>(
      `
      SELECT id
      FROM events
      WHERE type = 'turn.queued'
        AND json_extract(payload_json, '$.turn_id') = ?
      ORDER BY id DESC
      LIMIT 1
    `,
    )
    .get(input.turnId);
  if (!latestQueue) return false;
  const internalContinuationEventIds =
    internalContinuationProgressEventIds(input.db, input.turnId);
  const rows = input.db
    .query<EventRow, [number, string]>(
      `
      SELECT id, type, payload_json, created_at
      FROM events
      WHERE id > ?
        AND json_extract(payload_json, '$.turn_id') = ?
        AND type IN ('progress.summary', 'agent.turn_event.progress')
      ORDER BY id ASC
      LIMIT 1000
    `,
    )
    .all(latestQueue.id, input.turnId);
  const progressRows: ProgressSummaryRow[] = [];
  for (const event of rows) {
    const payload = safeParseRecord(event.payload_json);
    if (payload.turn_id !== input.turnId) continue;
    const eventId = safeOptionalShortToken(payload.event_id);
    if (
      event.type === "agent.turn_event.progress" &&
      eventId &&
      internalContinuationEventIds.has(eventId)
    ) {
      continue;
    }
    const row = payload.row;
    if (!isRecord(row)) continue;
    progressRows.push(normalizeProgressSummaryRow(row));
  }
  const turn = input.getTurnRow(input.turnId);
  return publicProgressRowsForTurn(progressRows, turn?.state).length > 0;
}

function internalContinuationProgressEventIds(
  db: Database,
  turnId: string,
): Set<string> {
  const rows = db
    .query<EventRow, [string]>(
      `
      SELECT id, type, payload_json, created_at
      FROM events
      WHERE type = 'agent.turn_event'
        AND json_extract(payload_json, '$.turn_id') = ?
      ORDER BY id DESC
      LIMIT 1000
    `,
    )
    .all(turnId);
  const eventIds = new Set<string>();
  for (const row of rows) {
    const payload = safeParseRecord(row.payload_json);
    if (payload.turn_id !== turnId) continue;
    const event = isRecord(payload.event) ? payload.event : null;
    const eventId = safeOptionalShortToken(event?.id);
    if (eventId && isInternalContinuationProgressEvent(event)) {
      eventIds.add(eventId);
    }
  }
  return eventIds;
}
