import { Database } from "bun:sqlite";
import { APP_PROTOCOL_VERSION, type AppEventEnvelope } from "../../interface/protocol/app-protocol.ts";
import type { EventRow } from "../core/records.ts";
import { publicAppEventPayload } from "./public-app-event-payload.ts";
import {
  isRecord,
  safeOptionalShortText,
  safeParseRecord,
} from "../core/projection-safe-values.ts";
import { eventTurnMatchSql } from "./event-turn-query.ts";
import {
  deliveryLimitationMetadataFromRecord,
  type DeliveryLimitationMetadata,
} from "../transport/app-delivery-projection.ts";
import {
  compactAppEvents,
  DEFAULT_EVENT_RETENTION_POLICY,
  type EventCompactionResult,
  type EventRetentionPolicy,
} from "./event-retention.ts";

export class AppEventStore {
  private readonly subscribers = new Set<(event: AppEventEnvelope) => void>();
  private readonly sessionTurnEventSequences = new Map<string, number>();
  private readonly turnEventSequences = new Map<string, number>();
  private readonly retentionPolicy: EventRetentionPolicy;
  private appendCountSinceCompaction = 0;

  constructor(
    private readonly db: Database,
    private readonly onEventAppended: (
      event: { turnId: string; eventId: number },
    ) => void = () => undefined,
    retentionPolicy: EventRetentionPolicy = {},
  ) {
    this.retentionPolicy = {
      ...DEFAULT_EVENT_RETENTION_POLICY,
      ...retentionPolicy,
    };
  }

  append(type: string, payload: Record<string, unknown>): AppEventEnvelope {
    const createdAt = new Date().toISOString();
    const publicPayload = publicAppEventPayload(type, payload);
    const turnId = eventTurnId(publicPayload);
    this.db
      .query(
        `
      INSERT INTO events (type, turn_id, payload_json, created_at)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(type, turnId, JSON.stringify(publicPayload), createdAt);
    const inserted = this.db
      .query<{ id: number }, []>("SELECT last_insert_rowid() AS id")
      .get();
    const row = this.db
      .query<EventRow, [number]>(
        `
      SELECT id, type, payload_json, created_at
      FROM events
      WHERE id = ?
    `,
      )
      .get(inserted?.id ?? 0);
    if (!row) throw new Error("Failed to append event.");
    this.onEventAppended({ turnId, eventId: row.id });
    const event: AppEventEnvelope = {
      protocol_version: APP_PROTOCOL_VERSION,
      id: row.id,
      type: row.type,
      created_at: row.created_at,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    };
    this.appendCountSinceCompaction += 1;
    if (this.appendCountSinceCompaction >= 256) {
      this.appendCountSinceCompaction = 0;
      try {
        this.compact();
      } catch {
        // Retention is maintenance; never mask the canonical append result.
      }
    }
    for (const listener of [...this.subscribers]) {
      try {
        listener(event);
      } catch {
        // Subscriber failures must not prevent future event replay.
      }
    }
    return event;
  }

  replay(cursor = 0, limit = 200): AppEventEnvelope[] {
    const boundedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(200, Math.floor(limit)))
      : 200;
    const rows = this.db
      .query<EventRow, [number, number]>(
        `
      SELECT id, type, payload_json, created_at
      FROM events
      WHERE id > ?
      ORDER BY id ASC
      LIMIT ?
    `,
      )
      .all(cursor, boundedLimit);
    return rows.map((row) => ({
      protocol_version: APP_PROTOCOL_VERSION,
      id: row.id,
      type: row.type,
      created_at: row.created_at,
      payload: publicAppEventPayload(
        row.type,
        JSON.parse(row.payload_json) as Record<string, unknown>,
      ),
    }));
  }

  latestCursor(): number {
    const row = this.db
      .query<{ id: number }, []>("SELECT COALESCE(MAX(id), 0) AS id FROM events")
      .get();
    return row?.id ?? 0;
  }

  compact(now = new Date()): EventCompactionResult {
    return compactAppEvents(this.db, this.retentionPolicy, now);
  }

  subscribe(listener: (event: AppEventEnvelope) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  nextSessionTurnEventSequence(sessionId: string): number {
    const next =
      (this.sessionTurnEventSequences.get(sessionId) ??
        this.lastPersistedTurnEventSequence("session", sessionId)) + 1;
    this.sessionTurnEventSequences.set(sessionId, next);
    return next;
  }

  nextTurnEventSequence(turnId: string): number {
    const next =
      (this.turnEventSequences.get(turnId) ??
        this.lastPersistedTurnEventSequence("turn", turnId)) + 1;
    this.turnEventSequences.set(turnId, next);
    return next;
  }

  cleanupTurnEventSequences(sessionId: string, turnId: string): void {
    this.turnEventSequences.delete(turnId);
    this.sessionTurnEventSequences.delete(sessionId);
  }

  hasTurnEventKind(turnId: string, kind: string): boolean {
    const row = this.db
      .query<{ id: number }, [string, string]>(
        `
      SELECT id
      FROM events
      WHERE type = 'agent.turn_event'
        AND ${eventTurnMatchSql(this.db)}
        AND json_extract(payload_json, '$.event.kind') = ?
      ORDER BY id DESC
      LIMIT 1
    `,
      )
      .get(turnId, kind);
    return Boolean(row);
  }

  runtimeFaultRecordForTurn(turnId: string): Record<string, unknown> | null {
    const row = this.db
      .query<EventRow, [string]>(
        `
      SELECT id, type, payload_json, created_at
      FROM events
      WHERE type = 'agent.turn_event'
        AND ${eventTurnMatchSql(this.db)}
        AND json_extract(payload_json, '$.event.kind') = 'runtime.fault'
      ORDER BY id DESC
      LIMIT 1
    `,
      )
      .get(turnId);
    if (!row) return null;
    const payload = safeParseRecord(row.payload_json);
    const event = isRecord(payload.event) ? payload.event : null;
    const fault = event && isRecord(event.payload) ? event.payload : null;
    if (!fault) return null;
    const faultId = safeOptionalShortText(fault.faultId);
    const kind = safeOptionalShortText(fault.kind);
    const publicSummary = safeOptionalShortText(fault.publicSummary);
    const retryable = fault.retryable === true;
    if (!faultId || !kind || !publicSummary) return null;
    return {
      faultId,
      kind,
      retryable,
      publicSummary,
      ...(safeOptionalShortText(fault.sessionId)
        ? { sessionId: safeOptionalShortText(fault.sessionId) }
        : {}),
      ...(safeOptionalShortText(fault.turnId)
        ? { turnId: safeOptionalShortText(fault.turnId) }
        : {}),
      ...(safeOptionalShortText(fault.operatorSummary)
        ? { operatorSummary: safeOptionalShortText(fault.operatorSummary) }
        : {}),
      ...(safeOptionalShortText(fault.safeErrorCode)
        ? { safeErrorCode: safeOptionalShortText(fault.safeErrorCode) }
        : {}),
      ...(safeOptionalShortText(fault.safeCause)
        ? { safeCause: safeOptionalShortText(fault.safeCause) }
        : {}),
      createdAt: safeOptionalShortText(fault.createdAt) ?? row.created_at,
    };
  }

  deliveryMetadataForTurn(turnId: string): DeliveryLimitationMetadata | null {
    const row = this.db.query<EventRow, [string]>(`
      SELECT id, type, payload_json, created_at
      FROM events
      WHERE type = 'agent.turn_event'
        AND ${eventTurnMatchSql(this.db)}
        AND (
          json_type(payload_json, '$.event.payload.delivery_state') IS NOT NULL
          OR json_type(payload_json, '$.event.payload.deliveryState') IS NOT NULL
        )
      ORDER BY id DESC
      LIMIT 1
    `).get(turnId);
    if (!row) return null;
    const payload = safeParseRecord(row.payload_json);
    const event = isRecord(payload.event) ? payload.event : null;
    const eventPayload = event && isRecord(event.payload) ? event.payload : null;
    return eventPayload
      ? deliveryLimitationMetadataFromRecord(eventPayload)
      : null;
  }

  private lastPersistedTurnEventSequence(
    scope: "session" | "turn",
    id: string,
  ): number {
    const rows = scope === "session"
      ? this.db
      .query<EventRow, [string]>(
        `
      SELECT id, type, payload_json, created_at
      FROM events
      WHERE type = 'agent.turn_event'
        AND json_extract(payload_json, '$.session_id') = ?
      ORDER BY id DESC
      LIMIT 20
    `,
      )
      .all(id)
      : this.db.query<EventRow, [string]>(`
        SELECT id, type, payload_json, created_at
        FROM events
        WHERE type = 'agent.turn_event' AND ${eventTurnMatchSql(this.db)}
        ORDER BY id DESC
        LIMIT 20
      `).all(id);
    for (const row of rows) {
      const payload = safeParseRecord(row.payload_json);
      if (scope === "session" && payload.session_id !== id) continue;
      if (scope === "turn" && payload.turn_id !== id) continue;
      const event = isRecord(payload.event) ? payload.event : {};
      const sequence =
        scope === "session" ? event.sessionSequence : event.turnSequence;
      if (
        typeof sequence === "number" &&
        Number.isInteger(sequence) &&
        sequence > 0
      ) {
        return sequence;
      }
    }
    return 0;
  }
}

function eventTurnId(payload: Record<string, unknown>): string {
  if (typeof payload.turn_id === "string") return payload.turn_id;
  const turn = isRecord(payload.turn) ? payload.turn : null;
  if (typeof turn?.id === "string") return turn.id;
  const message = isRecord(payload.message) ? payload.message : null;
  return typeof message?.turn_id === "string" ? message.turn_id : "";
}
