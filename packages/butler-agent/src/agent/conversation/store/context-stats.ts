import {
  type MessageRow,
} from "../store-internals.ts";
import { conversationMessagesSourceHash } from "../source-hash.ts";
import type { ConversationStoreDependencies } from "./dependencies.ts";

export interface ConversationMessageStats {
  semanticMessages: number;
  compactedMessages: number;
  latestMessageTimestamp: string | null;
}

/**
 * Metadata-only conversation reads used by periodic diagnostics and summary
 * validation. This boundary deliberately exposes counters and streamed source
 * identity, not an unbounded hydrated message collection.
 */
export class ConversationContextStatsRecords {
  constructor(private readonly dependencies: ConversationStoreDependencies) {}

  readMessageStats(sessionId: string): ConversationMessageStats {
    const counts = this.dependencies.db.query<{
      semantic_messages: number | null;
      compacted_messages: number | null;
    }, [string]>(`
      SELECT
        COALESCE(SUM(
          CASE
            WHEN compacted_by_summary_id IS NULL AND status != 'compacted' THEN 1
            ELSE 0
          END
        ), 0) AS semantic_messages,
        COALESCE(SUM(
          CASE
            WHEN compacted_by_summary_id IS NOT NULL OR status = 'compacted' THEN 1
            ELSE 0
          END
        ), 0) AS compacted_messages
      FROM conversation_messages
      WHERE session_id = ?
    `).get(sessionId);
    const latest = this.dependencies.db.query<{ created_at: string }, [string]>(`
      SELECT created_at
      FROM conversation_messages
      WHERE session_id = ?
      ORDER BY seq DESC
      LIMIT 1
    `).get(sessionId);
    return {
      semanticMessages: Number(counts?.semantic_messages ?? 0),
      compactedMessages: Number(counts?.compacted_messages ?? 0),
      latestMessageTimestamp: latest?.created_at ?? null,
    };
  }

  sourceHashForSeqRange(sessionId: string, fromSeq: number, toSeq: number): string {
    const rows = this.dependencies.db.query<MessageRow, [string, number, number]>(`
      SELECT *
      FROM conversation_messages
      WHERE session_id = ? AND seq BETWEEN ? AND ?
      ORDER BY seq ASC
    `).iterate(sessionId, fromSeq, toSeq);
    const dependencies = this.dependencies;
    return conversationMessagesSourceHash((function* () {
      for (const row of rows) {
        yield dependencies.internals.hydrateMessage(row);
      }
    })());
  }
}
