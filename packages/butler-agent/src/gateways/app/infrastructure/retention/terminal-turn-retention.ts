import type { Database } from "bun:sqlite";
import type { DeliveryLimitationMetadata } from
  "../transport/app-delivery-projection.ts";
import type { ProgressSummaryRow, TurnState } from
  "../../interface/protocol/app-protocol.ts";
import type { TerminalPhaseRetentionPort } from
  "./terminal-phase-retention-port.ts";
import { isRecord, safeParseRecord } from "../core/projection-safe-values.ts";
import { normalizeProgressSummaryRow } from
  "../../domain/progress-summary/progress-row-normalizer.ts";
import { publicProgressRowsForTurn } from
  "../../domain/progress-summary/public-progress-rows.ts";
import { InternalContinuationRetention } from
  "./internal-continuation-retention.ts";

const TERMINAL_STATES = new Set<TurnState>([
  "delivered", "failed", "cancelled", "runtime_fault",
]);
const LIVE_REPLAY_TAIL = 200;
const EVENT_DELETE_BATCH = 8;
const SNAPSHOT_SCAN_BATCH = 64;
const IDENTITY_DELETE_BATCH = 64;
const SNAPSHOT_SOURCE_TYPES = new Set([
  "agent.turn_event", "agent.turn_event.progress", "progress.summary",
]);

export type TerminalCompactionResult =
  | "complete"
  | "pending"
  | "not_ready"
  | { status: "waiting_for_event_cursor"; eventCursor: number };

export type TerminalTurnProjection = {
  progressRows: ProgressSummaryRow[];
  deliveryMetadata: DeliveryLimitationMetadata | null;
  sourceEventHighWater: number;
};

type ProjectionRecord = {
  terminal_state: TurnState;
  progress_rows_json: string;
  delivery_metadata_json: string | null;
  source_event_high_water: number;
};

type SnapshotRecord = { target_event_id: number; cursor_event_id: number };
type SnapshotEvent = { id: number; type: string; payload_json: string };

export class TerminalTurnRetention {
  private readonly hasTurnIndex: boolean;
  private readonly hasLegacyTurnIndex: boolean;
  private readonly internalContinuations: InternalContinuationRetention;

  constructor(
    private readonly db: Database,
    private readonly btcc: TerminalPhaseRetentionPort,
  ) {
    this.internalContinuations = new InternalContinuationRetention(db);
    this.hasTurnIndex = Boolean(this.db.query<{ name: string }, []>(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'events_turn_id_idx'
    `).get());
    this.hasLegacyTurnIndex = Boolean(this.db.query<{ name: string }, []>(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'events_type_turn_id_idx'
    `).get());
  }

  read(turnId: string): TerminalTurnProjection | null {
    const projection = this.projectionRecord(turnId);
    if (!projection) return null;
    const progressRows = JSON.parse(
      projection.progress_rows_json,
    ) as ProgressSummaryRow[];
    const retainedRows = this.db.query<{ row_json: string }, [string]>(`
      SELECT row_json FROM app_terminal_turn_progress_rows
      WHERE turn_id = ? ORDER BY source_event_id
    `).all(turnId);
    for (const retained of retainedRows) {
      progressRows.push(
        normalizeProgressSummaryRow(
          JSON.parse(retained.row_json) as ProgressSummaryRow,
        ),
      );
    }
    return {
      progressRows: publicProgressRowsForTurn(
        progressRows,
        projection.terminal_state,
      ),
      deliveryMetadata: projection.delivery_metadata_json
        ? JSON.parse(projection.delivery_metadata_json) as DeliveryLimitationMetadata
        : null,
      sourceEventHighWater: projection.source_event_high_water,
    };
  }

  compact(input: {
    turnId: string;
    chatId: string;
    state: TurnState;
    deliveryMetadata: DeliveryLimitationMetadata | null;
  }): TerminalCompactionResult {
    if (!TERMINAL_STATES.has(input.state) || !this.btcc.isSettled(input.turnId)) {
      return "not_ready";
    }
    return this.db.transaction(() => {
      const projection = this.projectionRecord(input.turnId);
      const snapshot = this.snapshotFor(input.turnId, projection);
      if (!this.copySnapshotPage(input.turnId, snapshot)) return "pending";
      const baseRows = projection?.progress_rows_json ?? "[]";
      this.writeProjection(input, baseRows, snapshot.target_event_id);
      this.db.query(`
        DELETE FROM app_terminal_turn_snapshot_state WHERE turn_id = ?
      `).run(input.turnId);
      this.deleteTurnEventJournal(input.turnId, snapshot.target_event_id);
      if (this.hasCompactableEvents(input.turnId, snapshot.target_event_id)) {
        return "pending";
      }
      const eventCursor = this.nextReplayTailWake(
        input.turnId,
        snapshot.target_event_id,
      );
      if (eventCursor !== null) {
        return { status: "waiting_for_event_cursor" as const, eventCursor };
      }
      if (this.internalContinuations.clearBatch(input.turnId)) return "pending";
      if (this.clearProgressIdentities(input.turnId)) return "pending";
      return "complete";
    })();
  }

  private projectionRecord(turnId: string): ProjectionRecord | null {
    return this.db.query<ProjectionRecord, [string]>(`
      SELECT terminal_state, progress_rows_json, delivery_metadata_json,
        source_event_high_water
      FROM app_terminal_turn_projections WHERE turn_id = ?
    `).get(turnId) ?? null;
  }

  private snapshotFor(
    turnId: string,
    projection: ProjectionRecord | null,
  ): SnapshotRecord {
    const existing = this.db.query<SnapshotRecord, [string]>(`
      SELECT target_event_id, cursor_event_id
      FROM app_terminal_turn_snapshot_state WHERE turn_id = ?
    `).get(turnId);
    if (existing) return existing;
    const target = this.latestEventId();
    const cursor = projection?.source_event_high_water ?? 0;
    this.db.query(`
      INSERT INTO app_terminal_turn_snapshot_state (
        turn_id, target_event_id, cursor_event_id
      ) VALUES (?, ?, ?)
    `).run(turnId, target, cursor);
    return { target_event_id: target, cursor_event_id: cursor };
  }

  private copySnapshotPage(turnId: string, snapshot: SnapshotRecord): boolean {
    if (snapshot.cursor_event_id >= snapshot.target_event_id) return true;
    const rows = this.snapshotEvents(turnId, snapshot);
    const page = rows.slice(0, SNAPSHOT_SCAN_BATCH);
    for (const event of page) {
      if (!SNAPSHOT_SOURCE_TYPES.has(event.type)) continue;
      const payload = safeParseRecord(event.payload_json);
      if (event.type === "agent.turn_event") {
        this.internalContinuations.rememberSource(turnId, payload);
        continue;
      }
      if (typeof payload.turn_id !== "string" || !isRecord(payload.row)) continue;
      if (
        event.type === "agent.turn_event.progress" &&
        this.internalContinuations.retainInternalProgress(
          turnId,
          payload,
          event.id,
        )
      ) continue;
      const row = normalizeProgressSummaryRow(payload.row);
      const rowJson = JSON.stringify(row);
      this.db.query(`
        INSERT OR IGNORE INTO app_progress_row_identities (turn_id, row_json)
        VALUES (?, ?)
      `).run(payload.turn_id, rowJson);
      if (payload.turn_id !== turnId) continue;
      this.db.query(`
        INSERT OR REPLACE INTO app_terminal_turn_progress_rows (
          turn_id, source_event_id, row_json
        ) VALUES (?, ?, ?)
      `).run(turnId, event.id, rowJson);
    }
    const complete = rows.length <= SNAPSHOT_SCAN_BATCH;
    const cursor = complete
      ? snapshot.target_event_id
      : page.at(-1)?.id ?? snapshot.cursor_event_id;
    this.db.query(`
      UPDATE app_terminal_turn_snapshot_state
      SET cursor_event_id = ? WHERE turn_id = ?
    `).run(cursor, turnId);
    snapshot.cursor_event_id = cursor;
    return complete;
  }

  private snapshotEvents(
    turnId: string,
    snapshot: SnapshotRecord,
  ): SnapshotEvent[] {
    if (this.hasTurnIndex) {
      return this.db.query<SnapshotEvent, [string, number, number, number]>(`
        SELECT id, type, payload_json FROM events INDEXED BY events_turn_id_idx
        WHERE turn_id = ? AND turn_id <> '' AND id > ? AND id <= ?
          AND type IN (
            'agent.turn_event', 'progress.summary', 'agent.turn_event.progress'
          )
        ORDER BY id LIMIT ?
      `).all(
        turnId,
        snapshot.cursor_event_id,
        snapshot.target_event_id,
        SNAPSHOT_SCAN_BATCH + 1,
      );
    }
    if (this.hasLegacyTurnIndex) {
      return this.db.query<SnapshotEvent, [string, number, number, number]>(`
        SELECT id, type, payload_json FROM events
          INDEXED BY events_type_turn_id_idx
        WHERE type IN (
          'agent.turn_event', 'progress.summary', 'agent.turn_event.progress'
        )
          AND json_extract(payload_json, '$.turn_id') = ?
          AND id > ? AND id <= ?
        ORDER BY id LIMIT ?
      `).all(
        turnId,
        snapshot.cursor_event_id,
        snapshot.target_event_id,
        SNAPSHOT_SCAN_BATCH + 1,
      );
    }
    return this.db.query<SnapshotEvent, [number, number, number]>(`
      SELECT id, type, payload_json FROM events
      WHERE id > ? AND id <= ? ORDER BY id LIMIT ?
    `).all(
      snapshot.cursor_event_id,
      snapshot.target_event_id,
      SNAPSHOT_SCAN_BATCH + 1,
    );
  }

  private writeProjection(
    input: {
      turnId: string;
      chatId: string;
      state: TurnState;
      deliveryMetadata: DeliveryLimitationMetadata | null;
    },
    progressRowsJson: string,
    highWater: number,
  ): void {
    this.db.query(`
      INSERT INTO app_terminal_turn_projections (
        turn_id, chat_id, terminal_state, progress_rows_json,
        delivery_metadata_json, source_event_high_water, compacted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(turn_id) DO UPDATE SET
        terminal_state = excluded.terminal_state,
        progress_rows_json = excluded.progress_rows_json,
        delivery_metadata_json = excluded.delivery_metadata_json,
        source_event_high_water = excluded.source_event_high_water,
        compacted_at = excluded.compacted_at
    `).run(
      input.turnId, input.chatId, input.state, progressRowsJson,
      input.deliveryMetadata ? JSON.stringify(input.deliveryMetadata) : null,
      highWater, new Date().toISOString(),
    );
  }

  private latestEventId(): number {
    return this.db.query<{ id: number }, []>(
      "SELECT COALESCE(MAX(id), 0) AS id FROM events",
    ).get()?.id ?? 0;
  }

  private compactThrough(highWater: number): number {
    return Math.min(
      highWater,
      Math.max(0, this.latestEventId() - LIVE_REPLAY_TAIL),
    );
  }

  private deleteTurnEventJournal(turnId: string, highWater: number): void {
    const through = this.compactThrough(highWater);
    if (through === 0) return;
    this.db.query(`
      DELETE FROM events WHERE id IN (
        SELECT events.id FROM events
        JOIN app_terminal_turn_progress_rows AS retained
          ON retained.source_event_id = events.id
        WHERE retained.turn_id = ? AND events.id <= ?
        ORDER BY events.id LIMIT ${EVENT_DELETE_BATCH}
      )
    `).run(turnId, through);
  }

  private hasCompactableEvents(turnId: string, highWater: number): boolean {
    return Boolean(this.db.query<{ id: number }, [string, number]>(`
      SELECT events.id FROM events
      JOIN app_terminal_turn_progress_rows AS retained
        ON retained.source_event_id = events.id
      WHERE retained.turn_id = ? AND events.id <= ? LIMIT 1
    `).get(turnId, this.compactThrough(highWater)));
  }

  private nextReplayTailWake(turnId: string, highWater: number): number | null {
    const row = this.db.query<{ id: number | null }, [string, number]>(`
      SELECT MIN(events.id) AS id FROM events
      JOIN app_terminal_turn_progress_rows AS retained
        ON retained.source_event_id = events.id
      WHERE retained.turn_id = ? AND events.id <= ?
    `).get(turnId, highWater);
    return row?.id == null ? null : row.id + LIVE_REPLAY_TAIL;
  }

  private clearProgressIdentities(turnId: string): boolean {
    this.db.query(`
      DELETE FROM app_progress_row_identities
      WHERE turn_id = ? AND row_json IN (
        SELECT row_json FROM app_progress_row_identities
        WHERE turn_id = ? LIMIT ${IDENTITY_DELETE_BATCH}
      )
    `).run(turnId, turnId);
    return Boolean(this.db.query<{ found: number }, [string]>(`
      SELECT 1 AS found FROM app_progress_row_identities
      WHERE turn_id = ? LIMIT 1
    `).get(turnId));
  }
}
