import { isoNow, type MessageRow, normalizeLimit } from "../store-internals.ts";
import type {
  AppendMessageInput,
  AppendToolPartInput,
  ConversationMessage,
  ConversationMessageWithParts,
  ConversationPart,
  ConversationRole,
  HistoricalOriginCandidate,
  RecordOriginClassificationInput,
  RecordOriginClassificationResult,
  ReadAroundInput,
  ReadCognitionMessagesInput,
  ReadMessagesInput,
} from "../types.ts";
import type { ConversationStoreDependencies } from "./dependencies.ts";
import { conversationMessagesSourceHash } from "../source-hash.ts";
export { conversationMessagesSourceHash } from "../source-hash.ts";

export class ConversationMessageRecords {
  constructor(private readonly dependencies: ConversationStoreDependencies) {}

  appendUserMessage(
    input: Omit<AppendMessageInput, "role">,
  ): ConversationMessageWithParts {
    return this.appendMessage({ ...input, role: "user" });
  }

  appendAssistantMessage(
    input: Omit<AppendMessageInput, "role">,
  ): ConversationMessageWithParts {
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

  readMessageBySourceRef(
    sessionId: string,
    sourceRef: string,
  ): ConversationMessageWithParts | null {
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

  readMessageBySourceRefAnySession(
    sourceRef: string,
  ): ConversationMessageWithParts | null {
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
    return this.hydrateRows(
      this.dependencies.db.query<MessageRow, [string, number]>(`
      SELECT *
      FROM conversation_messages
      WHERE session_id = ? ${compacted}
      ORDER BY seq ASC
      LIMIT ?
    `).all(input.sessionId, capped),
    );
  }

  readMessagesForTurn(turnId: string): ConversationMessageWithParts[] {
    return this.hydrateRows(
      this.dependencies.db.query<MessageRow, [string]>(`
      SELECT * FROM conversation_messages
      WHERE turn_id = ?
      ORDER BY seq ASC
    `).all(turnId),
    );
  }

  readCognitionMessages(
    input: ReadCognitionMessagesInput = {},
  ): ConversationMessageWithParts[] {
    const capped = normalizeLimit(input.limit ?? 1000, 1000, 5000);
    const offset = Number.isFinite(input.offset)
      ? Math.max(0, Math.floor(input.offset!))
      : 0;
    const order = input.order === "desc" ? "DESC" : "ASC";
    const params: Record<string, string | number> = {
      $limit: capped,
      $offset: offset,
    };
    const clauses: string[] = [];
    if (input.sessionId?.trim()) {
      clauses.push("session_id = $session_id");
      params.$session_id = input.sessionId.trim();
    }
    if (input.roles && input.roles.length > 0) {
      const roles = [...new Set(input.roles)];
      clauses.push(
        `role IN (${roles.map((_, index) => `$role${index}`).join(", ")})`,
      );
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
    const rows = this.dependencies.db.query<
      MessageRow,
      Record<string, string | number>
    >(`
      SELECT *
      FROM conversation_messages
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at ${order}, seq ${order}, id ${order}
      LIMIT $limit
      OFFSET $offset
    `).all(params);
    return this.hydrateRows(rows);
  }

  countSourceBearingMessages(): number {
    const row = this.dependencies.db.query<{ count: number }, []>(`
      SELECT COUNT(DISTINCT m.id) AS count
      FROM conversation_messages m
      JOIN conversation_parts p ON p.message_id = m.id
      WHERE p.kind IN ('text', 'message_content')
    `).get();
    return Number(row?.count ?? 0);
  }

  readProjectionMessages(
    sessionId: string,
    input: { afterSeq?: number; limit?: number } = {},
  ): ConversationMessageWithParts[] {
    const capped = normalizeLimit(input.limit ?? 500, 500, 1000);
    const afterSeq = Number.isFinite(input.afterSeq)
      ? Math.max(0, Math.floor(input.afterSeq!))
      : 0;
    return this.hydrateRows(
      this.dependencies.db.query<MessageRow, [string, number, number]>(`
      SELECT *
      FROM conversation_messages
      WHERE session_id = ?
        AND seq > ?
        AND compacted_by_summary_id IS NULL
        AND status != 'compacted'
      ORDER BY seq ASC
      LIMIT ?
    `).all(sessionId, afterSeq, capped),
    );
  }

  readSemanticTail(
    sessionId: string,
    limit = 20,
  ): ConversationMessageWithParts[] {
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
    return this.hydrateRows(
      this.dependencies.db.query<MessageRow, [string]>(`
      SELECT *
      FROM conversation_messages
      WHERE session_id = ? AND compacted_by_summary_id IS NULL AND status != 'compacted'
      ORDER BY seq ASC
    `).all(sessionId),
    );
  }

  readMessagesAround(input: ReadAroundInput): ConversationMessageWithParts[] {
    const limit = normalizeLimit(input.limit, 10, 80);
    const anchor = input.anchorMessageId
      ? this.dependencies.internals.messageById(input.anchorMessageId)
      : null;
    const compacted = input.includeCompacted
      ? ""
      : "AND compacted_by_summary_id IS NULL AND status != 'compacted'";
    const anchorSeq = anchor?.seq ??
      this.dependencies.internals.maxSeq(
        "conversation_messages",
        input.sessionId,
      );
    const range = this.dependencies.internals.rangeFor(
      anchorSeq,
      input.direction ?? "around",
      limit,
    );
    return this.hydrateRows(
      this.dependencies.db.query<MessageRow, [string, number, number, number]>(`
      SELECT *
      FROM conversation_messages
      WHERE session_id = ? AND seq BETWEEN ? AND ? ${compacted}
      ORDER BY seq ASC
      LIMIT ?
    `).all(input.sessionId, range.start, range.end, limit),
    );
  }

  readMessagesInSeqRange(
    sessionId: string,
    fromSeq: number,
    toSeq: number,
  ): ConversationMessageWithParts[] {
    return this.hydrateRows(
      this.dependencies.db.query<MessageRow, [string, number, number]>(`
      SELECT *
      FROM conversation_messages
      WHERE session_id = ? AND seq BETWEEN ? AND ?
      ORDER BY seq ASC
    `).all(sessionId, fromSeq, toSeq),
    );
  }

  referencedMessagesHash(messageIds: Array<string | null>): string {
    const messages = messageIds.flatMap((messageId) => {
      if (!messageId) return [];
      const row = this.dependencies.internals.messageById(messageId);
      return row ? [this.dependencies.internals.hydrateMessage(row)] : [];
    });
    return conversationMessagesSourceHash(messages);
  }

  readOriginCandidatesPage(
    afterMessageId: string | null,
    limit = 100,
  ): HistoricalOriginCandidate[] {
    const capped = normalizeLimit(limit, 100, 500);
    const rows = this.dependencies.db.query<{
      id: string; session_id: string; turn_id: string | null; request_id: string | null;
      source_gateway: string | null; external_session_id: string | null; source_ref: string | null; provenance: HistoricalOriginCandidate["provenance"]; role: "user" | "assistant";
      origin_kind: HistoricalOriginCandidate["origin_kind"]; origin_ref: string | null;
      origin_reason: string | null; origin_version: string | null; origin_evidence_json: string | null;
      outcome_id: string | null; outcome_generation: number | null;
      outcome_request_message_id: string | null; outcome_public_assistant_message_id: string | null;
    }, [string | null, number]>(`
      SELECT m.id,m.session_id,m.turn_id,t.request_id,m.source_gateway,
        (SELECT b.external_session_id FROM conversation_bindings b WHERE b.conversation_session_id=m.session_id AND b.gateway=m.source_gateway ORDER BY b.created_at LIMIT 1) external_session_id,
        m.source_ref,m.provenance,m.role,
        m.origin_kind,m.origin_ref,m.origin_reason,m.origin_version,m.origin_evidence_json,
        o.id outcome_id,o.generation outcome_generation,
        o.request_message_id outcome_request_message_id,o.public_assistant_message_id outcome_public_assistant_message_id
      FROM conversation_messages m
      LEFT JOIN conversation_turns t ON t.id=m.turn_id AND t.session_id=m.session_id
      LEFT JOIN conversation_turn_outcomes o ON o.turn_id=t.id
      WHERE m.id>COALESCE(?,'') AND m.visibility='model'
        AND ((m.turn_id IS NULL AND m.provenance IN ('recovered','imported') AND m.status IN ('complete','failed','compacted'))
          OR (t.id IS NOT NULL AND m.status IN ('complete','compacted')))
        AND m.role IN ('user','assistant')
      ORDER BY m.id LIMIT ?
    `).all(afterMessageId, capped);
    return rows.map((row) => {
      const message = this.readMessageById(row.id)!;
      return { ...row, message_id: row.id, source_hash: conversationMessagesSourceHash([message]) };
    });
  }

  recordOriginClassification(input: RecordOriginClassificationInput): RecordOriginClassificationResult {
    return this.dependencies.db.transaction(() => {
      const message = this.readMessageById(input.message_id);
      const turn = message?.turn_id
        ? this.dependencies.internals.getTurn(message.turn_id)
        : null;
      const outcome = turn ? this.dependencies.db.query<{
        id: string; generation: number; request_message_id: string | null;
        public_assistant_message_id: string | null;
      }, [string]>(
        "SELECT id,generation,request_message_id,public_assistant_message_id FROM conversation_turn_outcomes WHERE turn_id=?",
      ).get(turn.id) : null;
      if (!message || (message.turn_id !== null && !turn) ||
        (message.role !== "user" && message.role !== "assistant")) return "source_changed";
      const current: HistoricalOriginCandidate = {
        message_id: message.id,
        session_id: message.session_id,
        turn_id: turn?.id ?? null,
        request_id: turn?.request_id ?? null,
        source_gateway: message.source_gateway,
        external_session_id: this.dependencies.db.query<{ external_session_id: string }, [string, string]>(
          "SELECT external_session_id FROM conversation_bindings WHERE conversation_session_id=? AND gateway=? ORDER BY created_at LIMIT 1",
        ).get(message.session_id, message.source_gateway ?? "")?.external_session_id ?? null,
        source_ref: message.source_ref,
        provenance: message.provenance,
        role: message.role,
        origin_kind: message.origin_kind ?? "unknown",
        origin_ref: message.origin_ref ?? null,
        origin_reason: message.origin_reason ?? null,
        origin_version: message.origin_version ?? null,
        origin_evidence_json: message.origin_evidence_json ?? null,
        source_hash: conversationMessagesSourceHash([message]),
        outcome_id: outcome?.id ?? null,
        outcome_generation: outcome?.generation ?? null,
        outcome_request_message_id: outcome?.request_message_id ?? null,
        outcome_public_assistant_message_id: outcome?.public_assistant_message_id ?? null,
      };
      if (current.session_id !== input.session_id || current.turn_id !== input.turn_id ||
        current.request_id !== input.request_id || current.source_gateway !== input.source_gateway ||
        current.external_session_id !== input.external_session_id ||
        current.source_ref !== input.source_ref || current.provenance !== input.provenance || current.role !== input.role ||
        current.source_hash !== input.source_hash || current.outcome_id !== input.outcome_id ||
        current.outcome_generation !== input.outcome_generation ||
        current.outcome_request_message_id !== input.outcome_request_message_id ||
        current.outcome_public_assistant_message_id !== input.outcome_public_assistant_message_id)
        return "source_changed";
      const evidenceJson = JSON.stringify(input.decision.evidence);
      if (current.origin_kind !== input.origin_kind || current.origin_ref !== input.origin_ref ||
        current.origin_reason !== input.origin_reason || current.origin_version !== input.origin_version ||
        current.origin_evidence_json !== input.origin_evidence_json) return "source_changed";
      if (current.origin_version) {
        const unchanged = current.origin_kind === input.decision.kind && current.origin_ref === input.decision.ref &&
          current.origin_reason === input.decision.reason && current.origin_version === input.decision.version &&
          current.origin_evidence_json === evidenceJson;
        if (unchanged) return "unchanged";
        const internalCorrection = input.correctInternalOrigin === true && input.decision.complete &&
          input.decision.kind === "internal_control" &&
          input.decision.evidence.some((evidence) => evidence.kind === "subsession" && evidence.sha256 !== null);
        if (!internalCorrection) return "classification_conflict";
      }
      this.dependencies.db.query("UPDATE conversation_messages SET origin_kind=?,origin_ref=?,origin_reason=?,origin_version=?,origin_evidence_json=? WHERE id=?")
        .run(input.decision.kind, input.decision.ref, input.decision.reason, input.decision.version, evidenceJson, input.message_id);
      this.dependencies.internals.bumpPublicSourceRevision();
      const updatedMessage = this.dependencies.internals.messageById(input.message_id)!;
      this.dependencies.internals.enqueueProjection(updatedMessage.session_id, updatedMessage.seq, "conversation.message_committed", updatedMessage.id, isoNow());
      return "applied";
    })() as RecordOriginClassificationResult;
  }

  private appendMessage(
    input: AppendMessageInput & { role: ConversationRole },
  ): ConversationMessageWithParts {
    const now = input.now ?? isoNow();
    const message = this.messageForInsert(input, now);
    const tx = this.dependencies.db.transaction(() => {
      const inserted = this.dependencies.internals.insertMessage({
        ...message,
        seq: this.dependencies.internals.nextSeq(
          "conversation_messages",
          input.sessionId,
        ),
      });
      const parts = input.parts?.length
        ? input.parts
        : [{ kind: "text" as const, contentJson: { text: input.text } }];
      for (const part of parts) {
        this.dependencies.internals.insertPart(
          inserted.id,
          part.kind,
          part.contentJson,
          {
            toolCallId: part.toolCallId ?? null,
            parentToolCallId: part.parentToolCallId ?? null,
            providerShape: part.providerShape ?? null,
            status: part.status ?? "complete",
          },
        );
      }
      if (
        inserted.visibility === "model" &&
        (inserted.role === "user" && inserted.origin_kind === "user_input" ||
          inserted.role === "assistant" &&
            inserted.origin_kind === "assistant_public") &&
        parts.some((part) =>
          partHasCanonicalScalar(part.kind, part.contentJson),
        )
      ) {
        this.dependencies.internals.bumpPublicSourceRevision();
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

  private appendToolPart(
    kind: "tool_call" | "tool_result",
    input: AppendToolPartInput,
  ): ConversationPart {
    const message = this.dependencies.internals.messageById(input.messageId);
    if (!message) {
      throw new Error(`Conversation message not found: ${input.messageId}`);
    }
    const tx = this.dependencies.db.transaction(() => {
      const part = this.dependencies.internals.insertPart(
        input.messageId,
        kind,
        input.contentJson,
        {
          toolCallId: input.toolCallId,
          parentToolCallId: input.parentToolCallId ?? null,
          providerShape: input.providerShape ?? null,
          status: input.status ?? "complete",
        },
      );
      this.dependencies.internals.enqueueProjection(
        message.session_id,
        message.seq,
        kind === "tool_call"
          ? "conversation.tool_call_committed"
          : "conversation.tool_result_committed",
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
      origin_kind: input.originKind ?? "unknown",
      origin_ref: input.originRef ?? null,
      origin_reason: input.originReason ?? null,
      origin_version: input.originVersion ?? null,
      origin_evidence_json: input.originEvidence ? JSON.stringify(input.originEvidence) : null,
    };
  }

  private hydrateRows(rows: MessageRow[]): ConversationMessageWithParts[] {
    return rows.map((row) => this.dependencies.internals.hydrateMessage(row));
  }
}

function partHasCanonicalScalar(kind: string, value: unknown): boolean {
  if (kind === "text") {
    return Boolean(
      value && typeof value === "object" && !Array.isArray(value) &&
        typeof (value as { text?: unknown }).text === "string" &&
        (value as { text: string }).text.length,
    );
  }
  return kind === "message_content" && Array.isArray(value) &&
    value.some((item) =>
      item && typeof item === "object" && !Array.isArray(item) &&
      typeof (item as { text?: unknown }).text === "string" &&
      (item as { text: string }).text.length > 0,
    );
}
