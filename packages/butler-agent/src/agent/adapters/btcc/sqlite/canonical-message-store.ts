import type { Database } from "bun:sqlite";
import type { BtccRuntimeDependencies } from "../../../btcc/gateway-api.ts";

type CanonicalMessageStore = BtccRuntimeDependencies["messages"];

type OutboxRow = {
  payload_id: string;
  payload_sha256: string;
  expected_message_id: string;
  content: string;
  status: string;
};

export class SqliteCanonicalMessageStore implements CanonicalMessageStore {
  constructor(private readonly db: Database) {}

  async insertCanonicalAssistantMessage(input: {
    turnId: string;
    sessionId: string;
    outboxId: string;
    expectedMessageId: string;
    payloadRef: { id: string; sha256: string };
    content: string;
  }): Promise<{ messageId: string }> {
    const transaction = this.db.transaction(() => {
      const outbox = this.db.query<OutboxRow, [string, string]>(`
        SELECT payload_id, payload_sha256, expected_message_id, content, status
        FROM btcc_delivery_outbox WHERE outbox_id = ? AND turn_id = ?
      `).get(input.outboxId, input.turnId);
      if (
        !outbox ||
        outbox.payload_id !== input.payloadRef.id ||
        outbox.payload_sha256 !== input.payloadRef.sha256 ||
        outbox.expected_message_id !== input.expectedMessageId ||
        outbox.content !== input.content ||
        (outbox.status !== "pending" && outbox.status !== "inserted" && outbox.status !== "observed")
      ) {
        throw new Error("BTCC canonical delivery does not match its immutable Outbox");
      }
      const existing = this.db.query<{ content: string }, [string]>(`
        SELECT content FROM btcc_messages WHERE message_id = ?
      `).get(input.expectedMessageId);
      if (existing && existing.content !== input.content) {
        throw new Error("BTCC canonical assistant message identity conflict");
      }
      if (!existing) {
        this.db.query(`
          INSERT INTO btcc_messages (
            message_id, session_id, turn_id, role, content, idempotency_key, created_at
          ) VALUES (?, ?, ?, 'assistant', ?, ?, ?)
        `).run(
          input.expectedMessageId,
          input.sessionId,
          input.turnId,
          input.content,
          `delivery:${input.outboxId}`,
          new Date().toISOString(),
        );
      }
      this.db.query(`
        INSERT OR IGNORE INTO btcc_canonical_deliveries (
          turn_id, outbox_id, assistant_message_id, inserted_at
        ) VALUES (?, ?, ?, ?)
      `).run(input.turnId, input.outboxId, input.expectedMessageId, new Date().toISOString());
      const delivery = this.db.query<{
        outbox_id: string;
        assistant_message_id: string;
      }, [string]>(`
        SELECT outbox_id, assistant_message_id
        FROM btcc_canonical_deliveries WHERE turn_id = ?
      `).get(input.turnId);
      if (
        !delivery ||
        delivery.outbox_id !== input.outboxId ||
        delivery.assistant_message_id !== input.expectedMessageId
      ) {
        throw new Error("BTCC canonical delivery identity conflict");
      }
      this.db.query(`
        UPDATE btcc_delivery_outbox SET status = 'inserted'
        WHERE outbox_id = ? AND status = 'pending'
      `).run(input.outboxId);
      return { messageId: input.expectedMessageId };
    });
    return transaction() as { messageId: string };
  }
}
