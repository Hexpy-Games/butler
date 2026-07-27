import type { Database } from "bun:sqlite";
import type {
  DeliveryOutbox,
  PreparedReportProduct,
} from "../../../btcc/gateway-api.ts";
import { stableJson } from "./identity.ts";
import { SqliteImmutableRecordStore } from "./immutable-record-store.ts";

type PreparedDelivery = {
  product: PreparedReportProduct;
  deliveryOutbox: DeliveryOutbox;
};

export class ManagedDeliveryOutboxWriter {
  constructor(
    private readonly db: Database,
    private readonly records: SqliteImmutableRecordStore,
  ) {}

  prepare(turnId: string, nextRevision: number, transition: PreparedDelivery): void {
    this.insert("prepared_report", transition.product.report);
    this.insert("final_payload", transition.product.finalPayload);
    const outbox = transition.deliveryOutbox;
    this.db.query(`
      INSERT INTO btcc_delivery_outbox (
        outbox_id, turn_id, committed_turn_revision, payload_id, payload_sha256,
        expected_message_id, content, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      outbox.outboxId,
      turnId,
      nextRevision,
      outbox.finalPayloadRef.id,
      outbox.finalPayloadRef.sha256,
      outbox.expectedMessageId,
      outbox.content,
    );
  }

  private insert<T extends { ref: { id: string; sha256: string } }>(
    kind: string,
    value: T,
  ): void {
    this.records.insert(value.ref.id, kind, value.ref.sha256, stableJson(value));
  }
}
