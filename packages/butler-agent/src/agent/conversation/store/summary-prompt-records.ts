import { estimatePromptTokens, isoNow } from "../store-internals.ts";
import type {
  ConversationSummary,
  ConversationSummaryInput,
  PromptMaterial,
  PromptMaterialInput,
} from "../types.ts";
import type { ConversationStoreDependencies } from "./dependencies.ts";
import {
  conversationMessagesSourceHash,
  type ConversationMessageRecords,
} from "./message-records.ts";
import type { ConversationSessionTurnRecords } from "./session-turn-records.ts";

export class ConversationSummaryPromptRecords {
  constructor(
    private readonly dependencies: ConversationStoreDependencies,
    private readonly messages: ConversationMessageRecords,
    private readonly sessionsAndTurns: ConversationSessionTurnRecords,
  ) {}

  writeSummary(input: ConversationSummaryInput): ConversationSummary {
    const now = input.now ?? isoNow();
    const summary: ConversationSummary = {
      id: input.summaryId ?? this.dependencies.idFactory("csm"),
      session_id: input.sessionId,
      covers_from_seq: input.coversFromSeq,
      covers_to_seq: input.coversToSeq,
      source_hash: input.sourceHash,
      model: input.model ?? null,
      summary_text: input.summaryText,
      created_at: now,
      invalidated_at: null,
    };
    const tx = this.dependencies.db.transaction(() => {
      this.dependencies.db.query(`
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
      this.dependencies.db.query(`
        UPDATE conversation_messages
        SET status = 'compacted', compacted_by_summary_id = ?
        WHERE session_id = ? AND seq BETWEEN ? AND ?
      `).run(summary.id, summary.session_id, summary.covers_from_seq, summary.covers_to_seq);
      this.dependencies.internals.enqueueProjection(
        summary.session_id,
        summary.covers_to_seq,
        "conversation.summary_written",
        summary.id,
        now,
      );
      return summary;
    });
    return tx() as ConversationSummary;
  }

  readSummaries(sessionId: string): ConversationSummary[] {
    this.invalidateStaleSummaries(sessionId);
    return this.dependencies.db.query<ConversationSummary, [string]>(`
      SELECT *
      FROM conversation_summaries
      WHERE session_id = ? AND invalidated_at IS NULL
      ORDER BY covers_from_seq ASC, covers_to_seq ASC
    `).all(sessionId);
  }

  readPromptMaterial(input: PromptMaterialInput): PromptMaterial {
    const summaries = this.readSummaries(input.sessionId);
    const semanticTail = input.tailLimit === undefined
      ? this.messages.readAllSemanticTail(input.sessionId)
      : this.messages.readSemanticTail(input.sessionId, input.tailLimit);
    const turns = Array.from(new Set(
      semanticTail
        .map((message) => message.turn_id)
        .filter((turnId): turnId is string => Boolean(turnId)),
    )).flatMap((turnId) => {
      const turn = this.sessionsAndTurns.readTurn(turnId);
      return turn ? [turn] : [];
    });
    const outcomes = turns.flatMap((turn) => {
      const outcome = this.sessionsAndTurns.readTurnOutcome(turn.id);
      return outcome ? [outcome] : [];
    });
    return {
      session_id: input.sessionId,
      summaries,
      semantic_tail: semanticTail,
      current_turn: [],
      turns,
      outcomes,
      token_estimate: estimatePromptTokens(semanticTail, summaries),
      provenance: [
        ...summaries.map((summary) => ({ kind: "summary" as const, id: summary.id })),
        ...semanticTail.map((message) => ({ kind: "message" as const, id: message.id })),
      ],
    };
  }

  private invalidateStaleSummaries(sessionId: string): void {
    const summaries = this.dependencies.db.query<ConversationSummary, [string]>(`
      SELECT *
      FROM conversation_summaries
      WHERE session_id = ? AND invalidated_at IS NULL
      ORDER BY covers_from_seq ASC, covers_to_seq ASC
    `).all(sessionId);
    const stale = summaries.filter((summary) => {
      const messages = this.messages.readMessagesInSeqRange(
        summary.session_id,
        summary.covers_from_seq,
        summary.covers_to_seq,
      );
      return conversationMessagesSourceHash(messages) !== summary.source_hash;
    });
    if (stale.length === 0) return;
    const now = isoNow();
    const tx = this.dependencies.db.transaction(() => {
      for (const summary of stale) {
        this.dependencies.db
          .query("UPDATE conversation_summaries SET invalidated_at = ? WHERE id = ?")
          .run(now, summary.id);
        this.dependencies.db.query(`
          UPDATE conversation_messages
          SET status = 'complete', compacted_by_summary_id = NULL
          WHERE session_id = ? AND compacted_by_summary_id = ?
        `).run(summary.session_id, summary.id);
      }
    });
    tx();
  }
}
