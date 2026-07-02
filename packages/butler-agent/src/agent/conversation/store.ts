import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONVERSATION_STORE_SCHEMA_VERSION } from "./schema.ts";
import {
  ConversationStoreInternals,
  estimatePromptTokens,
  isoNow,
  type MessageRow,
  normalizeLimit,
} from "./store-internals.ts";
import {
  defaultConversationIdFactory,
  type ConversationIdFactory,
} from "./ids.ts";
import type {
  AppendMessageInput,
  AppendToolPartInput,
  BeginTurnInput,
  ConversationMessage,
  ConversationMessageWithParts,
  ConversationPart,
  ConversationProjectionEvent,
  ConversationRole,
  ConversationSession,
  ConversationSummary,
  ConversationSummaryInput,
  ConversationTurn,
  FinalizeTurnInput,
  PromptMaterial,
  PromptMaterialInput,
  ReadAroundInput,
} from "./types.ts";

export function conversationStorePath(butlerData: string): string {
  return join(butlerData, "runtime", "conversation-store.sqlite");
}

export class AgentConversationStore {
  private readonly db: Database;
  private readonly idFactory: ConversationIdFactory;
  private readonly internals: ConversationStoreInternals;
  constructor(input: { butlerData: string; dbPath?: string; idFactory?: ConversationIdFactory }) {
    const dbPath = input.dbPath ?? conversationStorePath(input.butlerData);
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.idFactory = input.idFactory ?? defaultConversationIdFactory;
    this.internals = new ConversationStoreInternals(this.db, this.idFactory);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.internals.ensureSchema();
  }

  close(): void {
    this.db.close();
  }

  beginTurn(input: BeginTurnInput): ConversationTurn {
    const now = input.now ?? isoNow();
    const sessionId = input.sessionId ?? this.idFactory("cs");
    const turnId = input.turnId ?? this.idFactory("ct");
    const tx = this.db.transaction(() => {
      this.internals.upsertSession({
        id: sessionId,
        workspace_id: input.workspaceId ?? null,
        project_id: input.projectId ?? null,
        gateway_origin: input.gateway,
        created_at: now,
        updated_at: now,
        status: "active",
        schema_version: CONVERSATION_STORE_SCHEMA_VERSION,
      });
      this.internals.upsertBinding(input.gateway, input.externalSessionId, sessionId, now);
      this.internals.enqueueProjection(sessionId, 0, "conversation.session_bound", sessionId, now);
      const turn = this.internals.insertTurn({
        id: turnId,
        session_id: sessionId,
        seq: this.internals.nextSeq("conversation_turns", sessionId),
        actor: input.actor,
        status: "running",
        request_id: input.requestId ?? null,
        started_at: now,
        completed_at: null,
      });
      this.internals.enqueueProjection(sessionId, turn.seq, "conversation.turn_started", turn.id, now);
      return turn;
    });
    return tx() as ConversationTurn;
  }

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

  finalizeTurn(input: FinalizeTurnInput): ConversationTurn {
    const completedAt = input.completedAt ?? isoNow();
    const status = input.status ?? "complete";
    this.db.query("UPDATE conversation_turns SET status = ?, completed_at = ? WHERE id = ?")
      .run(status, completedAt, input.turnId);
    const turn = this.internals.getTurn(input.turnId);
    if (!turn) throw new Error(`Conversation turn not found: ${input.turnId}`);
    return turn;
  }

  writeSummary(input: ConversationSummaryInput): ConversationSummary {
    const now = input.now ?? isoNow();
    const summary: ConversationSummary = {
      id: input.summaryId ?? this.idFactory("csm"),
      session_id: input.sessionId,
      covers_from_seq: input.coversFromSeq,
      covers_to_seq: input.coversToSeq,
      source_hash: input.sourceHash,
      model: input.model ?? null,
      summary_text: input.summaryText,
      created_at: now,
      invalidated_at: null,
    };
    const tx = this.db.transaction(() => {
      this.db.query(`
        INSERT INTO conversation_summaries (
          id, session_id, covers_from_seq, covers_to_seq, source_hash,
          model, summary_text, created_at, invalidated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        summary.id,
        summary.session_id,
        summary.covers_from_seq,
        summary.covers_to_seq,
        summary.source_hash,
        summary.model,
        summary.summary_text,
        summary.created_at,
        summary.invalidated_at,
      );
      this.db.query(`
        UPDATE conversation_messages
        SET status = 'compacted', compacted_by_summary_id = ?
        WHERE session_id = ? AND seq BETWEEN ? AND ?
      `).run(summary.id, summary.session_id, summary.covers_from_seq, summary.covers_to_seq);
      this.internals.enqueueProjection(summary.session_id, summary.covers_to_seq, "conversation.summary_written", summary.id, now);
      return summary;
    });
    return tx() as ConversationSummary;
  }

  getSessionByGatewayBinding(gateway: string, externalSessionId: string): ConversationSession | null {
    return this.db.query<ConversationSession, [string, string]>(`
      SELECT s.*
      FROM conversation_sessions s
      JOIN conversation_bindings b ON b.conversation_session_id = s.id
      WHERE b.gateway = ? AND b.external_session_id = ?
      LIMIT 1
    `).get(gateway, externalSessionId) ?? null;
  }

  readSemanticTail(sessionId: string, limit = 20): ConversationMessageWithParts[] {
    const capped = normalizeLimit(limit, 20, 200);
    const rows = this.db.query<MessageRow, [string, number]>(`
      SELECT *
      FROM conversation_messages
      WHERE session_id = ? AND compacted_by_summary_id IS NULL AND status != 'compacted'
      ORDER BY seq DESC
      LIMIT ?
    `).all(sessionId, capped).reverse();
    return rows.map((row) => this.internals.hydrateMessage(row));
  }

  readMessagesAround(input: ReadAroundInput): ConversationMessageWithParts[] {
    const limit = normalizeLimit(input.limit, 10, 80);
    const anchor = input.anchorMessageId ? this.internals.messageById(input.anchorMessageId) : null;
    const compacted = input.includeCompacted ? "" : "AND compacted_by_summary_id IS NULL AND status != 'compacted'";
    const anchorSeq = anchor?.seq ?? this.internals.maxSeq("conversation_messages", input.sessionId);
    const range = this.internals.rangeFor(anchorSeq, input.direction ?? "around", limit);
    const rows = this.db.query<MessageRow, [string, number, number, number]>(`
      SELECT *
      FROM conversation_messages
      WHERE session_id = ? AND seq BETWEEN ? AND ? ${compacted}
      ORDER BY seq ASC
      LIMIT ?
    `).all(input.sessionId, range.start, range.end, limit);
    return rows.map((row) => this.internals.hydrateMessage(row));
  }

  readSummaries(sessionId: string): ConversationSummary[] {
    return this.db.query<ConversationSummary, [string]>(`
      SELECT *
      FROM conversation_summaries
      WHERE session_id = ? AND invalidated_at IS NULL
      ORDER BY covers_from_seq ASC, covers_to_seq ASC
    `).all(sessionId);
  }

  readPromptMaterial(input: PromptMaterialInput): PromptMaterial {
    const summaries = this.readSummaries(input.sessionId);
    const semanticTail = this.readSemanticTail(input.sessionId, input.tailLimit ?? 20);
    return {
      session_id: input.sessionId,
      summaries,
      semantic_tail: semanticTail,
      current_turn: [],
      token_estimate: estimatePromptTokens(semanticTail, summaries),
      provenance: [
        ...summaries.map((summary) => ({ kind: "summary" as const, id: summary.id })),
        ...semanticTail.map((message) => ({ kind: "message" as const, id: message.id })),
      ],
    };
  }

  readProjectionBatch(afterOutboxId: string | null, limit = 100): ConversationProjectionEvent[] {
    const capped = normalizeLimit(limit, 100, 500);
    const afterRow = afterOutboxId
      ? this.db.query<{ outbox_rowid: number }, [string]>(
        "SELECT outbox_rowid FROM conversation_projection_outbox WHERE outbox_id = ?",
      ).get(afterOutboxId)?.outbox_rowid ?? 0
      : 0;
    return this.db.query<ConversationProjectionEvent, [number, number]>(`
      SELECT outbox_id, conversation_session_id, seq, kind, payload_ref, created_at
      FROM conversation_projection_outbox
      WHERE outbox_rowid > ?
      ORDER BY outbox_rowid ASC
      LIMIT ?
    `).all(afterRow, capped);
  }

  private appendMessage(input: AppendMessageInput & { role: ConversationRole }): ConversationMessageWithParts {
    const now = input.now ?? isoNow();
    const message = this.messageForInsert(input, now);
    const tx = this.db.transaction(() => {
      const inserted = this.internals.insertMessage({
        ...message,
        seq: this.internals.nextSeq("conversation_messages", input.sessionId),
      });
      const parts = input.parts?.length
        ? input.parts
        : [{ kind: "text" as const, contentJson: { text: input.text } }];
      for (const part of parts) {
        this.internals.insertPart(inserted.id, part.kind, part.contentJson, {
          toolCallId: part.toolCallId ?? null,
          parentToolCallId: part.parentToolCallId ?? null,
          providerShape: part.providerShape ?? null,
          status: part.status ?? "complete",
        });
      }
      this.internals.enqueueProjection(inserted.session_id, inserted.seq, "conversation.message_committed", inserted.id, now);
      return this.internals.hydrateMessage(inserted);
    });
    return tx() as ConversationMessageWithParts;
  }

  private appendToolPart(kind: "tool_call" | "tool_result", input: AppendToolPartInput): ConversationPart {
    const message = this.internals.messageById(input.messageId);
    if (!message) throw new Error(`Conversation message not found: ${input.messageId}`);
    const tx = this.db.transaction(() => {
      const part = this.internals.insertPart(input.messageId, kind, input.contentJson, {
        toolCallId: input.toolCallId,
        parentToolCallId: input.parentToolCallId ?? null,
        providerShape: input.providerShape ?? null,
        status: input.status ?? "complete",
      });
      this.internals.enqueueProjection(
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

  private messageForInsert(input: AppendMessageInput & { role: ConversationRole }, now: string): ConversationMessage {
    return {
      id: input.messageId ?? this.idFactory("cm"),
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
}
