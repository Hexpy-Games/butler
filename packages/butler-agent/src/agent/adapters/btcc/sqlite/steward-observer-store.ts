import type { Database } from "bun:sqlite";
import { readStewardObserverPlan } from "./steward-observer-plan-reader.ts";
import type {
  StewardObserverMessage,
  StewardObserverProgressEvent,
  StewardObserverReader,
  StewardObserverRelation,
  StewardObserverSnapshot,
  StewardObserverOperationOutputChunk,
  StewardObserverTurn,
} from "../../../../gateways/app/domain/sessions/steward-observer.ts";
import type { StewardResultView as StewardObserverResult } from
  "../../../../gateways/app/interface/protocol/app-protocol.ts";
import { normalizeOperationOutputChunkPayload } from "../../../events/operation-output-event.ts";

type RelationRow = StewardObserverRelation;

type MessageRow = {
  message_id: string;
  session_id: string;
  turn_id: string;
  role: "user" | "assistant" | string;
  content: string;
  idempotency_key: string;
  created_at: string;
};

type TurnRow = {
  turn_id: string;
  semantic_state: string;
  created_at: string;
};

type ProgressRow = {
  event_id: string;
  session_id: string;
  turn_id: string;
  session_sequence: number;
  turn_sequence: number;
  event_json: string;
  created_at: string;
};

type ResultRow = {
  result_id: string;
  relation_id: string;
  task_id: string;
  child_session_id: string;
  child_turn_id: string;
  status: StewardObserverResult["status"];
  code: StewardObserverResult["code"];
  summary: string;
  acceptance_evidence_json: string;
  changed_artifacts_json: string;
  created_at: string;
};

/**
 * Read-only projection over the durable BTCC relation/session tables. The App
 * never writes through this adapter; BTCC remains the sole owner of child
 * identity, transcript, progress, and result state.
 */
export class SqliteStewardObserverStore implements StewardObserverReader {
  constructor(private readonly db: Database) {}

  relationForParent(sessionId: string): StewardObserverRelation | null {
    return this.relation("parent_session_id", sessionId);
  }

  relationForChild(sessionId: string): StewardObserverRelation | null {
    return this.relation("child_session_id", sessionId);
  }

  snapshot(sessionId: string): StewardObserverSnapshot | null {
    const relation = this.relationForChild(sessionId);
    if (!relation) return null;
    const messages = this.db
      .query<MessageRow, [string]>(`
        SELECT message_id, session_id, turn_id, role, content, idempotency_key, created_at
        FROM btcc_messages
        WHERE session_id = ? AND role IN ('user', 'assistant')
          -- Steward dispatch inputs are durable internal continuation context,
          -- not user-facing transcript. Keep assistant/result messages public.
          AND message_id NOT LIKE 'steward-message:%'
          AND idempotency_key NOT LIKE 'inbound:%:steward:%'
        ORDER BY created_at ASC, message_id ASC
      `)
      .all(sessionId)
      .map<StewardObserverMessage>((message) => ({
        id: message.message_id,
        session_id: message.session_id,
        turn_id: message.turn_id,
        role: message.role === "user" ? "user" : "assistant",
        text: message.content,
        created_at: message.created_at,
        updated_at: message.created_at,
      }));
    const turns = this.db
      .query<TurnRow, [string, string]>(`
        SELECT turn_id, semantic_state, COALESCE(
          (SELECT created_at FROM btcc_progress_events p
            WHERE p.turn_id = t.turn_id ORDER BY p.turn_sequence ASC LIMIT 1),
          ?
        ) AS created_at
        FROM btcc_turns t
        WHERE session_id = ?
        ORDER BY rowid ASC
      `)
      .all(relation.created_at, sessionId)
      .map<StewardObserverTurn>((turn) => ({
        id: turn.turn_id,
        state: turn.semantic_state,
        created_at: turn.created_at,
        updated_at: turn.created_at,
      }));
    const progressEvents = this.db
      .query<ProgressRow, [string]>(`
        SELECT event_id, session_id, turn_id, session_sequence, turn_sequence,
          event_json, created_at
        FROM btcc_progress_events
        WHERE session_id = ?
        ORDER BY session_sequence ASC, event_id ASC
      `)
      .all(sessionId)
      .flatMap((row) => this.parseProgress(row));
    const result = this.resultForRelation(relation.relation_id);
    const plan = readStewardObserverPlan(this.db, sessionId);
    const updatedAt = latestTimestamp([
      relation.created_at,
      ...messages.map((message) => message.updated_at),
      ...progressEvents.map((event) => event.created_at),
      ...(result ? [result.created_at] : []),
    ]);
    return {
      session_id: sessionId,
      title: relation.safe_title,
      turns,
      messages,
      progress_events: progressEvents,
      plan,
      result,
      updated_at: updatedAt,
    };
  }

  readOperationOutputChunks(input: {
    turnId: string;
    requestId: string;
    resultId: string;
  }): StewardObserverOperationOutputChunk[] {
    const rows = this.db.query<{ event_json: string }, [string]>(`
      SELECT progress.event_json
      FROM btcc_progress_events AS progress
      JOIN btcc_turns AS turn
        ON turn.turn_id = progress.turn_id
       AND turn.session_id = progress.session_id
      JOIN btcc_session_relations AS relation
        ON relation.child_session_id = turn.session_id
      WHERE progress.turn_id = ?
        AND progress.session_id = relation.child_session_id
      ORDER BY progress.turn_sequence ASC, progress.event_id ASC
    `).all(input.turnId);
    const chunks: StewardObserverOperationOutputChunk[] = [];
    for (const row of rows) {
      const event = parseOutputEvent(row.event_json);
      if (!event) continue;
      try {
        const payload = normalizeOperationOutputChunkPayload(event.payload);
        if (payload.requestId !== input.requestId || payload.resultId !== input.resultId) {
          continue;
        }
        chunks.push({
          request_id: payload.requestId,
          result_id: payload.resultId,
          result_sha256: payload.resultSha256,
          chunk_index: payload.chunkIndex,
          chunk_count: payload.chunkCount,
          byte_start: payload.byteStart,
          byte_end: payload.byteEnd,
          byte_length: payload.byteLength,
          content_base64: payload.contentBase64,
          content_sha256: payload.contentSha256,
        });
      } catch {
        // Invalid or private output is not an observer result.
      }
    }
    return chunks;
  }

  private relation(
    field: "parent_session_id" | "child_session_id",
    sessionId: string,
  ): StewardObserverRelation | null {
    const row = this.db
      .query<RelationRow, [string]>(`
        SELECT relation_id, parent_session_id, parent_turn_id, child_session_id,
          anchor_message_id, ordinal, safe_title, created_at
        FROM btcc_session_relations
        WHERE ${field} = ?
        ORDER BY ordinal ASC
        LIMIT 1
      `)
      .get(sessionId);
    return row ?? null;
  }

  private resultForRelation(relationId: string): StewardObserverResult | null {
    const row = this.db
      .query<ResultRow, [string]>(`
        SELECT result_id, relation_id, task_id, child_session_id, child_turn_id,
          status, code, summary, acceptance_evidence_json,
          changed_artifacts_json, created_at
        FROM btcc_steward_results
        WHERE relation_id = ?
      `)
      .get(relationId);
    if (!row) return null;
    return {
      result_id: row.result_id,
      relation_id: row.relation_id,
      task_id: row.task_id,
      child_session_id: row.child_session_id,
      child_turn_id: row.child_turn_id,
      status: row.status,
      code: row.code ?? null,
      summary: row.summary,
      acceptance_evidence: parseStringList(row.acceptance_evidence_json),
      changed_artifacts: parseStringList(row.changed_artifacts_json),
      created_at: row.created_at,
    };
  }

  private parseProgress(row: ProgressRow): StewardObserverProgressEvent[] {
    try {
      const event = JSON.parse(row.event_json) as {
        kind?: unknown;
        visibility?: unknown;
        payload?: unknown;
      };
      if (typeof event.kind !== "string" ||
        (event.visibility !== "public" && event.visibility !== "internal")) return [];
      return [{
        id: row.event_id,
        session_id: row.session_id,
        turn_id: row.turn_id,
        session_sequence: row.session_sequence,
        turn_sequence: row.turn_sequence,
        kind: event.kind,
        visibility: event.visibility,
        payload: isRecord(event.payload) ? event.payload : {},
        created_at: row.created_at,
      }];
    } catch {
      return [];
    }
  }
}

function parseOutputEvent(value: string): {
  kind: "operation.output.chunk";
  visibility: "public";
  payload: Record<string, unknown>;
} | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || parsed.kind !== "operation.output.chunk" ||
      parsed.visibility !== "public" || !isRecord(parsed.payload)) return null;
    return {
      kind: "operation.output.chunk",
      visibility: "public",
      payload: parsed.payload,
    };
  } catch {
    return null;
  }
}

function parseStringList(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function latestTimestamp(values: string[]): string {
  return values.reduce(
    (latest, value) => (value > latest ? value : latest),
    values[0] ?? new Date(0).toISOString(),
  );
}
