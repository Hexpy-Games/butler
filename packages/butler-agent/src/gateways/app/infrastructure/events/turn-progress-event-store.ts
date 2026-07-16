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
    this.input.appendEvent("agent.turn_event", {
      session_id: sessionId,
      turn_id: turnId,
      event,
    });
    const progressRow = progressRowFromTurnEvent(event);
    if (progressRow) {
      const row = normalizeProgressSummaryRow(progressRow);
      this.updateActiveTurnProgressSummary(turnId, row);
      this.input.appendEvent("agent.turn_event.progress", {
        session_id: sessionId,
        turn_id: turnId,
        row,
        event_id: event.id,
      });
    }
    return event;
  }

  appendProgressSummaryEvent(
    sessionId: string,
    turnId: string,
    input: ProgressSummaryInput,
  ): ProgressSummaryRow {
    const row = normalizeProgressSummaryRow(input);
    if (this.input.isTerminalTurn(turnId)) return row;
    this.updateActiveTurnProgressSummary(turnId, row);
    const event = turnEventFromProgressRow({
      sessionId,
      turnId,
      row,
      sessionSequence: this.input.nextSessionTurnEventSequence(sessionId),
      turnSequence: this.input.nextTurnEventSequence(turnId),
    });
    this.input.appendEvent("agent.turn_event", {
      session_id: sessionId,
      turn_id: turnId,
      event,
    });
    this.input.appendEvent("progress.summary", {
      session_id: sessionId,
      turn_id: turnId,
      row,
    });
    return row;
  }

  listProgressRowsForTurn(turnId: string): ProgressSummaryRow[] {
    const internalContinuationEventIds =
      this.internalContinuationProgressEventIds(turnId);
    const rows = this.input.db
      .query<EventRow, [string]>(
        `
      SELECT id, type, payload_json, created_at
      FROM events
      WHERE type IN ('progress.summary', 'agent.turn_event.progress')
        AND json_extract(payload_json, '$.turn_id') = ?
      ORDER BY id DESC
      LIMIT 1000
    `,
      )
      .all(turnId);
    const progressRows: ProgressSummaryRow[] = [];
    for (const event of rows.reverse()) {
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
    const rows = this.input.db
      .query<EventRow, [string]>(
        `
      SELECT id, type, payload_json, created_at
      FROM events
      WHERE type IN ('progress.summary', 'agent.turn_event.progress')
        AND json_extract(payload_json, '$.turn_id') = ?
      ORDER BY id DESC
    `,
      )
      .all(turnId);
    return rows.some((row) => {
      const payload = safeParseRecord(row.payload_json);
      if (payload.turn_id !== turnId) return false;
      const progress = isRecord(payload.row) ? payload.row : null;
      if (!progress) return false;
      return progressRowsEquivalent(
        normalizeProgressSummaryRow(progress),
        incoming,
      );
    });
  }

  internalContinuationProgressEventIds(turnId: string): Set<string> {
    const rows = this.input.db
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
        AND state NOT IN ('delivered', 'failed', 'cancelled', 'waiting_runtime')
    `,
      )
      .run(label, row.created_at ?? new Date().toISOString(), turnId);
  }
}
