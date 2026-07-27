import { Database } from "bun:sqlite";
import {
  createAgentTurnEvent,
  progressRowFromTurnEvent,
  turnEventFromProgressRow,
  type AgentTurnEvent,
  type RuntimeTurnEventInput,
} from "../../../../agent/events/turn-events.ts";
import type { EventRow, TurnRow } from "../core/records.ts";
import {
  isRecord,
  safeOptionalShortToken,
  safeParseRecord,
} from "../core/projection-safe-values.ts";
import {
  normalizeProgressSummaryRow,
  type ProgressSummaryInput,
} from "../../domain/progress-summary/progress-row-normalizer.ts";
import {
  isTerminalProgressState,
  progressRowsEquivalent,
} from "../../domain/progress-summary/progress-row-merge.ts";
import {
  isInternalContinuationProgressEvent,
  progressSummaryStatusLabel,
  publicProgressRowsForTurn,
} from "../../domain/progress-summary/public-progress-rows.ts";
import type { AppEventEnvelope, ProgressSummaryRow } from "../../interface/protocol/app-protocol.ts";
import type { TerminalTurnProjection } from
  "../retention/terminal-turn-retention.ts";
import { eventTurnMatchSql } from "./event-turn-query.ts";

export class AppTurnProgressEventStore {
  constructor(
    private readonly input: {
      db: Database;
      appendEvent: (
        type: string,
        payload: Record<string, unknown>,
      ) => AppEventEnvelope;
      nextSessionTurnEventSequence: (sessionId: string) => number;
      nextTurnEventSequence: (turnId: string) => number;
      shouldPersistRuntimeTurnEvent: (turnId: string, kind: string) => boolean;
      isTerminalTurn: (turnId: string) => boolean;
      getTurnRow: (turnId: string) => TurnRow | null;
      terminalProjectionForTurn: (turnId: string) => TerminalTurnProjection | null;
    },
  ) {}

  appendTurnEvent(
    sessionId: string,
    turnId: string,
    input: RuntimeTurnEventInput,
  ): AgentTurnEvent {
    const shouldPersist = this.input.shouldPersistRuntimeTurnEvent(
      turnId,
      input.kind,
    );
    const event = createAgentTurnEvent({
      sessionId,
      turnId,
      sessionSequence: this.input.nextSessionTurnEventSequence(sessionId),
      turnSequence: this.input.nextTurnEventSequence(turnId),
      kind: input.kind,
      visibility: input.visibility,
      payload: input.payload,
      createdAt: input.createdAt,
    });
    if (!shouldPersist || event.visibility !== "public") return event;
    const progressRow = progressRowFromTurnEvent(event);
    this.input.db.transaction(() => {
      this.input.appendEvent("agent.turn_event", {
        session_id: sessionId,
        turn_id: turnId,
        event,
      });
      if (!progressRow) return;
      const row = normalizeProgressSummaryRow(progressRow);
      this.updateActiveTurnProgressSummary(turnId, row);
      this.input.appendEvent("agent.turn_event.progress", {
        session_id: sessionId, turn_id: turnId, row, event_id: event.id,
      });
      this.rememberProgressIdentity(turnId, row);
    })();
    return event;
  }

  appendProgressSummaryEvent(
    sessionId: string,
    turnId: string,
    input: ProgressSummaryInput,
  ): ProgressSummaryRow {
    const row = normalizeProgressSummaryRow(input);
    if (this.input.isTerminalTurn(turnId)) return row;
    const event = turnEventFromProgressRow({
      sessionId,
      turnId,
      row,
      sessionSequence: this.input.nextSessionTurnEventSequence(sessionId),
      turnSequence: this.input.nextTurnEventSequence(turnId),
    });
    this.input.db.transaction(() => {
      this.updateActiveTurnProgressSummary(turnId, row);
      this.input.appendEvent("agent.turn_event", {
        session_id: sessionId, turn_id: turnId, event,
      });
      this.input.appendEvent("progress.summary", {
        session_id: sessionId, turn_id: turnId, row,
      });
      this.rememberProgressIdentity(turnId, row);
    })();
    return row;
  }

  listProgressRowsForTurn(turnId: string): ProgressSummaryRow[] {
    const internalContinuationEventIds =
      this.internalContinuationProgressEventIds(turnId);
    const retained = this.input.terminalProjectionForTurn(turnId);
    const rows = this.progressEventRowsAfter(
      turnId,
      retained?.sourceEventHighWater ?? 0,
    );
    const progressRows: ProgressSummaryRow[] = [
      ...(retained?.progressRows ?? []),
    ];
    for (const event of rows) {
      const payload = safeParseRecord(event.payload_json);
      if (payload.turn_id !== turnId) continue;
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
    const turn = this.input.getTurnRow(turnId);
    return publicProgressRowsForTurn(progressRows, turn?.state);
  }

  hasEquivalentProgressSummaryRow(
    turnId: string,
    input: ProgressSummaryInput,
  ): boolean {
    const incoming = normalizeProgressSummaryRow(input);
    const retained = this.input.terminalProjectionForTurn(turnId)?.progressRows ?? [];
    if (retained.some((row) => progressRowsEquivalent(row, incoming))) return true;
    const rowJson = JSON.stringify(incoming);
    if (this.input.db.query<{ found: number }, [string, string]>(`
      SELECT 1 AS found FROM app_progress_row_identities
      WHERE turn_id = ? AND row_json = ?
    `).get(turnId, rowJson)) return true;
    return false;
  }

  internalContinuationProgressEventIds(turnId: string): Set<string> {
    const rows = this.input.db
      .query<EventRow, [string]>(
        `
      SELECT id, type, payload_json, created_at
      FROM events
      WHERE type = 'agent.turn_event'
        AND ${eventTurnMatchSql(this.input.db, { legacyPayload: "direct" })}
        AND json_extract(payload_json, '$.event.kind') = 'tool.progress'
        AND json_extract(payload_json, '$.event.payload.activityKind') = 'model'
      ORDER BY id DESC
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

  hasPublicContinuationProgressSinceLatestQueue(turnId: string): boolean {
    const latestQueue = this.input.db.query<{ id: number }, [string]>(`
      SELECT id FROM events
      WHERE type = 'turn.queued'
        AND ${eventTurnMatchSql(this.input.db, { legacyPayload: "direct" })}
      ORDER BY id DESC LIMIT 1
    `).get(turnId);
    if (!latestQueue) return false;
    const internalEventIds = this.internalContinuationProgressEventIds(turnId);
    let cursor = latestQueue.id;
    while (true) {
      const rows = this.input.db.query<EventRow, [number, string]>(`
        SELECT id, type, payload_json, created_at FROM events
        WHERE id > ?
          AND ${eventTurnMatchSql(this.input.db, {
            parameterIndex: 2,
            legacyPayload: "direct",
          })}
          AND type IN ('progress.summary', 'agent.turn_event.progress')
        ORDER BY id ASC LIMIT 256
      `).all(cursor, turnId);
      const progressRows: ProgressSummaryRow[] = [];
      for (const row of rows) {
        const payload = safeParseRecord(row.payload_json);
        if (payload.turn_id !== turnId) continue;
        const eventId = safeOptionalShortToken(payload.event_id);
        if (
          row.type === "agent.turn_event.progress" &&
          eventId && internalEventIds.has(eventId)
        ) continue;
        if (isRecord(payload.row)) {
          progressRows.push(normalizeProgressSummaryRow(payload.row));
        }
      }
      if (publicProgressRowsForTurn(
        progressRows,
        this.input.getTurnRow(turnId)?.state,
      ).length > 0) return true;
      if (rows.length < 256) return false;
      cursor = rows.at(-1)!.id;
    }
  }

  private updateActiveTurnProgressSummary(
    turnId: string,
    row: ProgressSummaryRow,
  ): void {
    if (isTerminalProgressState(row.state)) return;
    const label = progressSummaryStatusLabel(row);
    if (!label) return;
    this.input.db
      .query(
        `
      UPDATE turns
      SET safe_status_label = ?, updated_at = ?
      WHERE id = ?
        AND state NOT IN ('delivered', 'failed', 'cancelled')
    `,
      )
      .run(label, row.created_at ?? new Date().toISOString(), turnId);
  }

  private progressEventRowsAfter(turnId: string, afterId: number): EventRow[] {
    const rows: EventRow[] = [];
    let cursor = afterId;
    while (true) {
      const page = this.input.db.query<EventRow, [number, string]>(`
        SELECT id, type, payload_json, created_at FROM events
        WHERE id > ?
          AND type IN ('progress.summary', 'agent.turn_event.progress')
          AND ${eventTurnMatchSql(this.input.db, { legacyPayload: "direct" })}
        ORDER BY id LIMIT 256
      `).all(cursor, turnId);
      rows.push(...page);
      if (page.length < 256) return rows;
      cursor = page.at(-1)!.id;
    }
  }

  private rememberProgressIdentity(
    turnId: string,
    row: ProgressSummaryRow,
  ): void {
    this.input.db.query(`
      INSERT OR IGNORE INTO app_progress_row_identities (turn_id, row_json)
      VALUES (?, ?)
    `).run(turnId, JSON.stringify(row));
  }
}
