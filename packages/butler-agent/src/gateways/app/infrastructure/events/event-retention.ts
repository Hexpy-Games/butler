import type { Database } from "bun:sqlite";

export const DEFAULT_EVENT_RETENTION_POLICY = Object.freeze({
  /** Keep a bounded replay window even when durable events dominate. */
  maxRows: 50_000,
  /** Old compactable events are not useful for live recovery after this age. */
  maxAgeMs: 7 * 24 * 60 * 60 * 1_000,
  /** Delete a small page so compaction is crash-resumable and latency bounded. */
  deleteBatchSize: 256,
  /** Keep a small durable replay tail for reconnects even below maxRows. */
  liveReplayTail: 200,
});

export interface EventRetentionPolicy {
  maxRows?: number;
  maxAgeMs?: number;
  deleteBatchSize?: number;
  liveReplayTail?: number;
}

export interface EventCompactionResult {
  deleted: number;
  remainingCompactable: boolean;
}

/**
 * Event retention is intentionally conservative. Canonical message/turn and
 * session audit events remain durable; only non-canonical telemetry rows are
 * eligible when they cross either the age or row window. TerminalTurnRetention
 * owns the terminal turn-event snapshot source types below, so the generic
 * pass never races that queue and deletes a source before projection.
 */
export function compactAppEvents(
  db: Database,
  policy: EventRetentionPolicy = {},
  now = new Date(),
): EventCompactionResult {
  const maxRows = boundedInteger(
    policy.maxRows,
    DEFAULT_EVENT_RETENTION_POLICY.maxRows,
    1,
    1_000_000,
  );
  const maxAgeMs = boundedInteger(
    policy.maxAgeMs,
    DEFAULT_EVENT_RETENTION_POLICY.maxAgeMs,
    0,
    365 * 24 * 60 * 60 * 1_000,
  );
  const deleteBatchSize = boundedInteger(
    policy.deleteBatchSize,
    DEFAULT_EVENT_RETENTION_POLICY.deleteBatchSize,
    1,
    2_000,
  );
  const liveReplayTail = boundedInteger(
    policy.liveReplayTail,
    DEFAULT_EVENT_RETENTION_POLICY.liveReplayTail,
    1,
    2_000,
  );
  const ageCutoff = new Date(now.getTime() - maxAgeMs).toISOString();
  const latestEventId = db
    .query<{ id: number }, []>("SELECT COALESCE(MAX(id), 0) AS id FROM events")
    .get()?.id ?? 0;
  const rowCutoff = db
    .query<{ id: number }, [number]>(
      "SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?",
    )
    .get(maxRows)?.id ?? 0;
  const liveReplayFloor = Math.max(0, latestEventId - liveReplayTail);
  if (!latestEventId || (!rowCutoff && !liveReplayFloor)) {
    return { deleted: 0, remainingCompactable: false };
  }

  const candidates = db
    .query<{ id: number }, [number, string, number, number, number]>(`
      SELECT e.id
      FROM events e
      WHERE e.id <= ?
        AND (e.created_at < ? OR (? > 0 AND e.id <= ?))
        AND ${compactableEventPredicate("e")}
        AND NOT EXISTS (
          SELECT 1 FROM turns active_turn
          WHERE active_turn.id = e.turn_id
            AND (
              active_turn.state NOT IN ('delivered', 'failed', 'cancelled', 'runtime_fault')
              OR active_turn.retryable = 1
            )
        )
      ORDER BY e.id ASC
      LIMIT ?
    `)
    .all(liveReplayFloor, ageCutoff, rowCutoff, rowCutoff, deleteBatchSize);
  if (candidates.length === 0) return { deleted: 0, remainingCompactable: false };
  const ids = candidates.map((row) => row.id);
  const placeholders = ids.map(() => "?").join(", ");
  db.query(`DELETE FROM events WHERE id IN (${placeholders})`).run(...ids);
  const remaining = db
    .query<{ id: number }, [number, string, number, number]>(`
      SELECT e.id
      FROM events e
      WHERE e.id <= ?
        AND (e.created_at < ? OR (? > 0 AND e.id <= ?))
        AND ${compactableEventPredicate("e")}
        AND NOT EXISTS (
          SELECT 1 FROM turns active_turn
          WHERE active_turn.id = e.turn_id
            AND (
              active_turn.state NOT IN ('delivered', 'failed', 'cancelled', 'runtime_fault')
              OR active_turn.retryable = 1
            )
        )
      LIMIT 1
    `)
    .get(liveReplayFloor, ageCutoff, rowCutoff, rowCutoff);
  return { deleted: ids.length, remainingCompactable: Boolean(remaining) };
}

function compactableEventPredicate(alias: string): string {
  return `
    ${alias}.type NOT LIKE 'message.%'
    AND ${alias}.type NOT LIKE 'session.%'
    AND ${alias}.type NOT LIKE 'project.%'
    AND ${alias}.type NOT LIKE 'turn.%'
    AND ${alias}.type NOT LIKE 'ledger.%'
    AND ${alias}.type NOT LIKE 'audit.%'
    AND ${alias}.type NOT LIKE 'worker_activity_controlled%'
    AND ${alias}.type NOT IN (
      'agent.turn_event',
      'agent.turn_event.progress',
      'progress.summary'
    )
  `;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = Number(value);
  return Number.isFinite(candidate)
    ? Math.max(minimum, Math.min(maximum, Math.floor(candidate)))
    : fallback;
}
