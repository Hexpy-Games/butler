import { normalizeLimit } from "../store-internals.ts";
import type { ConversationMessageWithParts, ConversationProjectionEvent, TurnOutcomeCapsule } from "../types.ts";
import type { ConversationStoreDependencies } from "./dependencies.ts";
import { ConversationMessageRecords } from "./message-records.ts";

export class ConversationProjectionRecords {
  constructor(private readonly dependencies: ConversationStoreDependencies) {}

  readProjectionBatch(afterOutboxId: string | null, limit = 100): ConversationProjectionEvent[] {
    const capped = normalizeLimit(limit, 100, 500);
    const afterRow = afterOutboxId
      ? this.dependencies.db.query<{ outbox_rowid: number }, [string]>(
        "SELECT outbox_rowid FROM conversation_projection_outbox WHERE outbox_id = ?",
      ).get(afterOutboxId)?.outbox_rowid ?? 0
      : 0;
    return this.dependencies.db.query<ConversationProjectionEvent, [number, number]>(`
      SELECT outbox_id, conversation_session_id, seq, kind, payload_ref, created_at
      FROM conversation_projection_outbox
      WHERE outbox_rowid > ?
      ORDER BY outbox_rowid ASC
      LIMIT ?
    `).all(afterRow, capped);
  }

  readTurnOutcomes(afterOutcomeId: string | null, limit = 100): TurnOutcomeCapsule[] {
    const capped = normalizeLimit(limit, 100, 500);
    const afterRow = afterOutcomeId
      ? this.dependencies.db.query<{ rowid: number }, [string]>(
        "SELECT rowid FROM conversation_turn_outcomes WHERE id = ?",
      ).get(afterOutcomeId)?.rowid ?? 0
      : 0;
    const rows = this.dependencies.db.query<{
      rowid: number;
      id: string;
      session_id: string;
      turn_id: string;
      generation: number;
      outcome: TurnOutcomeCapsule["outcome"];
      source_hash: string;
      request_message_id: string | null;
      public_assistant_message_id: string | null;
      provider_id: string | null;
      model_ref: string | null;
      evidence_refs_json: string;
      unresolved_obligations_json: string;
      continuation_json: string | null;
      safe_code: string | null;
      created_at: string;
    }, [number, number]>(`
      SELECT rowid, *
      FROM conversation_turn_outcomes
      WHERE rowid > ? AND NOT EXISTS (
        SELECT 1 FROM conversation_turn_outcomes newer
        WHERE newer.turn_id=conversation_turn_outcomes.turn_id
          AND (newer.generation>conversation_turn_outcomes.generation OR
            (newer.generation=conversation_turn_outcomes.generation AND newer.rowid>conversation_turn_outcomes.rowid))
      )
      ORDER BY rowid ASC
      LIMIT ?
    `).all(afterRow, capped);
    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      turn_id: row.turn_id,
      generation: row.generation,
      outcome: row.outcome,
      source_hash: row.source_hash,
      request_message_id: row.request_message_id,
      public_assistant_message_id: row.public_assistant_message_id,
      provider_id: row.provider_id,
      model_ref: row.model_ref,
      evidence_refs: JSON.parse(row.evidence_refs_json) as string[],
      unresolved_obligations: JSON.parse(row.unresolved_obligations_json) as string[],
      continuation: row.continuation_json
        ? JSON.parse(row.continuation_json) as Record<string, unknown>
        : null,
      safe_code: row.safe_code,
      created_at: row.created_at,
    }));
  }

  readRecoveredSourceMessages(afterMessageId: string | null, limit = 100): ConversationMessageWithParts[] {
    const capped = normalizeLimit(limit, 100, 500);
    const afterRow = afterMessageId
      ? this.dependencies.db.query<{ rowid: number }, [string]>("SELECT rowid FROM conversation_messages WHERE id=?").get(afterMessageId)?.rowid ?? 0
      : 0;
    const ids = this.dependencies.db.query<{ id: string }, [number, number]>(`
      SELECT id FROM conversation_messages
      WHERE rowid>? AND turn_id IS NULL AND (
        (role='user' AND origin_kind='user_input' AND status IN ('complete','failed','compacted') AND provenance IN ('recovered','imported')) OR
        (role='assistant' AND origin_kind='assistant_public' AND status='complete' AND provenance='recovered')
      )
      ORDER BY rowid LIMIT ?
    `).all(afterRow, capped);
    const messages = new ConversationMessageRecords(this.dependencies);
    return ids.map(({ id }) => messages.readMessageById(id)).filter((value): value is ConversationMessageWithParts => Boolean(value));
  }
}
