import { normalizeLimit } from "../store-internals.ts";
import type { ConversationProjectionEvent } from "../types.ts";
import type { ConversationStoreDependencies } from "./dependencies.ts";

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
}
