import { createHash } from "node:crypto";
import {
  isoNow,
  type MessageRow,
  normalizeLimit,
} from "../store-internals.ts";
import type {
  AppendMessageInput,
  AppendToolPartInput,
  ConversationMessage,
  ConversationMessageWithParts,
  ConversationPart,
  ConversationRole,
  ReadAroundInput,
  ReadCognitionMessagesInput,
  ReadMessagesInput,
} from "../types.ts";
import type { ConversationStoreDependencies } from "./dependencies.ts";

export class ConversationMessageRecords {
  constructor(private readonly dependencies: ConversationStoreDependencies) {}

  appendUserMessage(input: Omit<AppendMessageInput, "role">): ConversationMessageWithParts {
    return this.appendMessage({ ...input, role: "user" });
  }

  appendAssistantMessage(input: Omit<AppendMessageInput, "role">): ConversationMessageWithParts {
    return this.appendMessage({ ...input, role: "assistant" });
  }

  appendToolCall(input: AppendToolPartInput): ConversationPart {
    return this.appendToolPart("tool_call", input);
  }

  appendToolResult(input: AppendToolPartInput): ConversationPart {
    return this.appendToolPart("tool_result", input);
  }

  readMessageById(messageId: string): ConversationMessageWithParts | null {
    const row = this.dependencies.internals.messageById(messageId);
    return row ? this.dependencies.internals.hydrateMessage(row) : null;
  }

  readMessageBySourceRef(sessionId: string, sourceRef: string): ConversationMessageWithParts | null {
    const trimmed = sourceRef.trim();
    if (!trimmed) return null;
    const row = this.dependencies.db.query<MessageRow, [string, string]>(`
      SELECT *
      FROM conversation_messages
      WHERE session_id = ? AND source_ref = ?
      ORDER BY seq ASC
      LIMIT 1
    `).get(sessionId, trimmed);
    return row ? this.dependencies.internals.hydrateMessage(row) : null;
  }

  readMessageBySourceRefAnySession(sourceRef: string): ConversationMessageWithParts | null {
    const trimmed = sourceRef.trim();
    if (!trimmed) return null;
    const row = this.dependencies.db.query<MessageRow, [string]>(`
      SELECT *
      FROM conversation_messages
      WHERE source_ref = ?
      ORDER BY created_at ASC, session_id ASC, seq ASC
      LIMIT 1
    `).get(trimmed);
    return row ? this.dependencies.internals.hydrateMessage(row) : null;
  }

  readMessages(input: ReadMessagesInput): ConversationMessageWithParts[] {
    const capped = normalizeLimit(input.limit ?? 500, 500, 5000);
    const compacted = input.includeCompacted
      ? ""
      : "AND compacted_by_summary_id IS NULL AND status != 'compacted'";
    return this.hydrateRows(this.dependencies.db.query<MessageRow, [string, number]>(`
      SELECT *
      FROM conversation_messages
      WHERE session_id = ? ${compacted}
      ORDER BY seq ASC
      LIMIT ?
    `).all(input.sessionId, capped));
  }

  readMessagesForTurn(turnId: string): ConversationMessageWithParts[] {
    return this.hydrateRows(this.dependencies.db.query<MessageRow, [string]>(`
      SELECT * FROM conversation_messages
      WHERE turn_id = ?
      ORDER BY seq ASC
    `).all(turnId));
  }

  readCognitionMessages(input: ReadCognitionMessagesInput = {}): ConversationMessageWithParts[] {
    const capped = normalizeLimit(input.limit ?? 1000, 1000, 5000);
    const offset = Number.isFinite(input.offset) ? Math.max(0, Math.floor(input.offset!)) : 0;
    const order = input.order === "desc" ? "DESC" : "ASC";
    const params: Record<string, string | number> = { $limit: capped, $offset: offset };
    const clauses: string[] = [];
    if (input.sessionId?.trim()) {
      clauses.push("session_id = $session_id");
      params.$session_id = input.sessionId.trim();
    }
    if (input.roles && input.roles.length > 0) {
      const roles = [...new Set(input.roles)];
      clauses.push(`role IN (${roles.map((_, index) => `$role${index}`).join(", ")})`);
      roles.forEach((role, index) => {
        params[`$role${index}`] = role;
      });
    }
    if (input.since?.trim()) {
      clauses.push("created_at >= $since");
      params.$since = input.since.trim();
    }
    clauses.push("visibility = 'model'");
    if (!input.includeCompacted) {
      clauses.push("compacted_by_summary_id IS NULL");
      clauses.push("status != 'compacted'");
    }
    const rows = this.dependencies.db.query<MessageRow, Record<string, string | number>>(`
      SELECT *
      FROM conversation_messages
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at ${order}, seq ${order}, id ${order}
      LIMIT $limit
      OFFSET $offset
    `).all(params);
    return this.hydrateRows(rows);
  }

  readProjectionMessages(
    sessionId: string,
    input: { afterSeq?: number; limit?: number } = {},
  ): ConversationMessageWithParts[] {
    const capped = normalizeLimit(input.limit ?? 500, 500, 1000);
    const afterSeq = Number.isFinite(input.afterSeq)
      ? Math.max(0, Math.floor(input.afterSeq!))
      : 0;
    return this.hydrateRows(this.dependencies.db.query<MessageRow, [string, number, number]>(`
      SELECT *
      FROM conversation_messages
      WHERE session_id = ?
        AND seq > ?
        AND compacted_by_summary_id IS NULL
        AND status != 'compacted'
      ORDER BY seq ASC
      LIMIT ?
    `).all(sessionId, afterSeq, capped));
  }

  readSemanticTail(sessionId: string, limit = 20): ConversationMessageWithParts[] {
    const capped = normalizeLimit(limit, 20, 200);
    const rows = this.dependencies.db.query<MessageRow, [string, number]>(`
      SELECT *
      FROM conversation_messages
      WHERE session_id = ? AND compacted_by_summary_id IS NULL AND status != 'compacted'
      ORDER BY seq DESC
      LIMIT ?
    `).all(sessionId, capped).reverse();
    return this.hydrateRows(rows);
  }

  readAllSemanticTail(sessionId: string): ConversationMessageWithParts[] {
    return this.hydrateRows(this.dependencies.db.query<MessageRow, [string]>(`
      SELECT *
      FROM conversation_messages
      WHERE session_id = ? AND compacted_by_summary_id IS NULL AND status != 'compacted'
      ORDER BY seq ASC
    `).all(sessionId));
  }

  readMessagesAround(input: ReadAroundInput): ConversationMessageWithParts[] {
    const limit = normalizeLimit(input.limit, 10, 80);
    const anchor = input.anchorMessageId
      ? this.dependencies.internals.messageById(input.anchorMessageId)
      : null;
    const compacted = input.includeCompacted
      ? ""
      : "AND compacted_by_summary_id IS NULL AND status != 'compacted'";
    const anchorSeq = anchor?.seq
      ?? this.dependencies.internals.maxSeq("conversation_messages", input.sessionId);
    const range = this.dependencies.internals.rangeFor(anchorSeq, input.direction ?? "around", limit);
    return this.hydrateRows(this.dependencies.db.query<MessageRow, [string, number, number, number]>(`
      SELECT *
      FROM conversation_messages
      WHERE session_id = ? AND seq BETWEEN ? AND ? ${compacted}
      ORDER BY seq ASC
      LIMIT ?
    `).all(input.sessionId, range.start, range.end, limit));
  }

  readMessagesInSeqRange(
    sessionId: string,
    fromSeq: number,
    toSeq: number,
  ): ConversationMessageWithParts[] {
    return this.hydrateRows(this.dependencies.db.query<MessageRow, [string, number, number]>(`
      SELECT *
      FROM conversation_messages
      WHERE session_id = ? AND seq BETWEEN ? AND ?
      ORDER BY seq ASC
    `).all(sessionId, fromSeq, toSeq));
  }

  referencedMessagesHash(messageIds: Array<string | null>): string {
    const messages = messageIds.flatMap((messageId) => {
      if (!messageId) return [];
      const row = this.dependencies.internals.messageById(messageId);
      return row ? [this.dependencies.internals.hydrateMessage(row)] : [];
    });
    return conversationMessagesSourceHash(messages);
  }

  private appendMessage(input: AppendMessageInput & { role: ConversationRole }): ConversationMessageWithParts {
    const now = input.now ?? isoNow();
    const message = this.messageForInsert(input, now);
    const tx = this.dependencies.db.transaction(() => {
      const inserted = this.dependencies.internals.insertMessage({
        ...message,
        seq: this.dependencies.internals.nextSeq("conversation_messages", input.sessionId),
      });
      const parts = input.parts?.length
        ? input.parts
        : [{ kind: "text" as const, contentJson: { text: input.text } }];
      for (const part of parts) {
        this.dependencies.internals.insertPart(inserted.id, part.kind, part.contentJson, {
          toolCallId: part.toolCallId ?? null,
          parentToolCallId: part.parentToolCallId ?? null,
          providerShape: part.providerShape ?? null,
          status: part.status ?? "complete",
        });
      }
      this.dependencies.internals.enqueueProjection(
        inserted.session_id,
        inserted.seq,
        "conversation.message_committed",
        inserted.id,
        now,
      );
      return this.dependencies.internals.hydrateMessage(inserted);
    });
    return tx() as ConversationMessageWithParts;
  }

  private appendToolPart(kind: "tool_call" | "tool_result", input: AppendToolPartInput): ConversationPart {
    const message = this.dependencies.internals.messageById(input.messageId);
    if (!message) throw new Error(`Conversation message not found: ${input.messageId}`);
    const tx = this.dependencies.db.transaction(() => {
      const part = this.dependencies.internals.insertPart(input.messageId, kind, input.contentJson, {
        toolCallId: input.toolCallId,
        parentToolCallId: input.parentToolCallId ?? null,
        providerShape: input.providerShape ?? null,
        status: input.status ?? "complete",
      });
      this.dependencies.internals.enqueueProjection(
        message.session_id,
        message.seq,
        kind === "tool_call" ? "conversation.tool_call_committed" : "conversation.tool_result_committed",
        part.id,
        isoNow(),
      );
      return part;
    });
    return tx() as ConversationPart;
  }

  private messageForInsert(
    input: AppendMessageInput & { role: ConversationRole },
    now: string,
  ): ConversationMessage {
    return {
      id: input.messageId ?? this.dependencies.idFactory("cm"),
      session_id: input.sessionId,
      turn_id: input.turnId ?? null,
      seq: 0,
      role: input.role,
      status: input.status ?? "complete",
      visibility: input.visibility ?? "model",
      provenance: input.provenance ?? "trusted",
      created_at: now,
      compacted_by_summary_id: null,
      source_gateway: input.sourceGateway ?? null,
      source_ref: input.sourceRef ?? null,
    };
  }

  private hydrateRows(rows: MessageRow[]): ConversationMessageWithParts[] {
    return rows.map((row) => this.dependencies.internals.hydrateMessage(row));
  }
}

export function conversationMessagesSourceHash(messages: ConversationMessageWithParts[]): string {
  const payload = messages.map((message) => ({
    id: message.id,
    session_id: message.session_id,
    turn_id: message.turn_id,
    seq: message.seq,
    role: message.role,
    visibility: message.visibility,
    provenance: message.provenance,
    created_at: message.created_at,
    source_gateway: message.source_gateway,
    source_ref: message.source_ref,
    parts: message.parts.map((part) => ({
      id: part.id,
      part_index: part.part_index,
      kind: part.kind,
      content_json: part.content_json,
      tool_call_id: part.tool_call_id,
      parent_tool_call_id: part.parent_tool_call_id,
      provider_shape: part.provider_shape,
      status: part.status,
    })),
  }));
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}
