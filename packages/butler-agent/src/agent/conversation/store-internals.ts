import type { Database } from "bun:sqlite";
import {
  CONVERSATION_STORE_SCHEMA_SQL,
  CONVERSATION_STORE_SCHEMA_VERSION,
} from "./schema.ts";
import type { ConversationIdFactory } from "./ids.ts";
import type {
  ConversationBinding,
  ConversationMessage,
  ConversationMessageWithParts,
  ConversationPart,
  ConversationPartKind,
  ConversationProjectionEvent,
  ConversationProviderShape,
  ConversationSession,
  ConversationStatus,
  ConversationSummary,
  ConversationTurn,
} from "./types.ts";

export interface MessageRow extends Omit<ConversationMessage, "seq"> {
  seq: number;
}

interface PartRow extends Omit<ConversationPart, "content_json"> {
  content_json: string;
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function normalizeLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value!)));
}

export function estimatePromptTokens(messages: ConversationMessageWithParts[], summaries: ConversationSummary[]): number {
  const text = [
    ...summaries.map((summary) => summary.summary_text),
    ...messages.flatMap((message) => message.parts.map((part) => JSON.stringify(part.content_json))),
  ].join("\n");
  return Math.ceil(text.length / 4);
}

export class ConversationStoreInternals {
  constructor(
    private readonly db: Database,
    private readonly idFactory: ConversationIdFactory,
  ) {}

  ensureSchema(): void {
    this.db.exec(CONVERSATION_STORE_SCHEMA_SQL);
    this.db.query(`
      INSERT OR IGNORE INTO conversation_schema_migrations (version, applied_at)
      VALUES (?, ?)
    `).run(CONVERSATION_STORE_SCHEMA_VERSION, isoNow());
  }

  upsertSession(session: ConversationSession): void {
    this.db.query(`
      INSERT INTO conversation_sessions (
        id, workspace_id, project_id, gateway_origin, created_at, updated_at, status, schema_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        project_id = excluded.project_id,
        gateway_origin = excluded.gateway_origin,
        updated_at = excluded.updated_at,
        status = excluded.status,
        schema_version = excluded.schema_version
    `).run(
      session.id,
      session.workspace_id,
      session.project_id,
      session.gateway_origin,
      session.created_at,
      session.updated_at,
      session.status,
      session.schema_version,
    );
  }

  upsertBinding(gateway: string, externalSessionId: string, sessionId: string, createdAt: string): ConversationBinding {
    this.db.query(`
      INSERT INTO conversation_bindings (gateway, external_session_id, conversation_session_id, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(gateway, external_session_id) DO UPDATE SET
        conversation_session_id = excluded.conversation_session_id
    `).run(gateway, externalSessionId, sessionId, createdAt);
    return { gateway, external_session_id: externalSessionId, conversation_session_id: sessionId, created_at: createdAt };
  }

  insertTurn(turn: ConversationTurn): ConversationTurn {
    this.db.query(`
      INSERT INTO conversation_turns (
        id, session_id, seq, actor, status, request_id, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(turn.id, turn.session_id, turn.seq, turn.actor, turn.status, turn.request_id, turn.started_at, turn.completed_at);
    return turn;
  }

  insertMessage(message: ConversationMessage): ConversationMessage {
    this.db.query(`
      INSERT INTO conversation_messages (
        id, session_id, turn_id, seq, role, status, visibility, provenance,
        created_at, compacted_by_summary_id, source_gateway, source_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.session_id,
      message.turn_id,
      message.seq,
      message.role,
      message.status,
      message.visibility,
      message.provenance,
      message.created_at,
      message.compacted_by_summary_id,
      message.source_gateway,
      message.source_ref,
    );
    return message;
  }

  insertPart(
    messageId: string,
    kind: ConversationPartKind,
    contentJson: unknown,
    input: {
      toolCallId: string | null;
      parentToolCallId: string | null;
      providerShape: ConversationProviderShape;
      status: ConversationStatus;
    },
  ): ConversationPart {
    const part: ConversationPart = {
      id: this.idFactory("cp"),
      message_id: messageId,
      part_index: this.nextPartIndex(messageId),
      kind,
      content_json: contentJson,
      tool_call_id: input.toolCallId,
      parent_tool_call_id: input.parentToolCallId,
      provider_shape: input.providerShape,
      status: input.status,
    };
    this.db.query(`
      INSERT INTO conversation_parts (
        id, message_id, part_index, kind, content_json,
        tool_call_id, parent_tool_call_id, provider_shape, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      part.id,
      part.message_id,
      part.part_index,
      part.kind,
      JSON.stringify(contentJson),
      part.tool_call_id,
      part.parent_tool_call_id,
      part.provider_shape,
      part.status,
    );
    return part;
  }

  enqueueProjection(sessionId: string, seq: number, kind: ConversationProjectionEvent["kind"], payloadRef: string, now: string): void {
    this.db.query(`
      INSERT INTO conversation_projection_outbox (
        outbox_id, conversation_session_id, seq, kind, payload_ref, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(this.idFactory("cpo"), sessionId, seq, kind, payloadRef, now);
  }

  hydrateMessage(row: MessageRow): ConversationMessageWithParts {
    return {
      ...row,
      parts: this.db.query<PartRow, [string]>(`
        SELECT *
        FROM conversation_parts
        WHERE message_id = ?
        ORDER BY part_index ASC
      `).all(row.id).map((part) => ({ ...part, content_json: JSON.parse(part.content_json) })),
    };
  }

  messageById(messageId: string): MessageRow | null {
    return this.db.query<MessageRow, [string]>("SELECT * FROM conversation_messages WHERE id = ?").get(messageId) ?? null;
  }

  getTurn(turnId: string): ConversationTurn | null {
    return this.db.query<ConversationTurn, [string]>("SELECT * FROM conversation_turns WHERE id = ?").get(turnId) ?? null;
  }

  nextSeq(table: "conversation_turns" | "conversation_messages", sessionId: string): number {
    const row = this.db.query<{ seq: number | null }, [string]>(
      `SELECT MAX(seq) AS seq FROM ${table} WHERE session_id = ?`,
    ).get(sessionId);
    return Number(row?.seq ?? 0) + 1;
  }

  maxSeq(table: "conversation_turns" | "conversation_messages", sessionId: string): number {
    return Number(this.db.query<{ seq: number | null }, [string]>(
      `SELECT MAX(seq) AS seq FROM ${table} WHERE session_id = ?`,
    ).get(sessionId)?.seq ?? 0);
  }

  rangeFor(anchorSeq: number, direction: "before" | "after" | "around", limit: number): { start: number; end: number } {
    if (direction === "before") return { start: Math.max(1, anchorSeq - limit + 1), end: anchorSeq };
    if (direction === "after") return { start: anchorSeq, end: anchorSeq + limit - 1 };
    const before = Math.floor((limit - 1) / 2);
    return { start: Math.max(1, anchorSeq - before), end: anchorSeq + limit - before - 1 };
  }

  private nextPartIndex(messageId: string): number {
    return Number(this.db.query<{ part_index: number | null }, [string]>(
      "SELECT MAX(part_index) AS part_index FROM conversation_parts WHERE message_id = ?",
    ).get(messageId)?.part_index ?? -1) + 1;
  }
}
