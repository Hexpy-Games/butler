import type { Database } from "bun:sqlite";
import { digest, stableJson } from "../identity.ts";
import type { LegacyTurnRow } from "./legacy-turn-preflight.ts";

type ExistingOutbox = {
  outbox_id: string;
  payload_id: string;
  payload_sha256: string;
  expected_message_id: string;
  content: string;
  status: string;
};

export function settleQuarantinedTurn(
  db: Database,
  turn: LegacyTurnRow,
): void {
  const revision = turn.revision + 1;
  const fence = turn.execution_fence + 1;
  const existingOutbox = db.query<ExistingOutbox, [string]>(`
    SELECT outbox_id, payload_id, payload_sha256, expected_message_id,
      content, status
    FROM btcc_delivery_outbox WHERE turn_id = ?
  `).get(turn.turn_id);
  const canonicalMessageId = existingCanonicalMessageId(
    db,
    turn,
    existingOutbox,
  );
  const delivery = existingOutbox
    ? deliveryFromExistingOutbox(existingOutbox)
    : canonicalMessageId
      ? deliveryForCanonicalMessage(db, turn, revision, canonicalMessageId)
      : limitationDelivery(turn, revision);
  const delivered = Boolean(canonicalMessageId);
  const checkpointId = delivered
    ? null
    : digest(`btcc-r3-quarantine-checkpoint.v1\0${turn.turn_id}\0${revision}`);
  const finalPayload = {
    ref: {
      id: delivery.payloadId,
      sha256: delivery.payloadSha256,
    },
    turnId: turn.turn_id,
    contentSha256: digest(delivery.content),
    route: "assisted" as const,
    disposition: "completed" as const,
    content: delivery.content,
  };
  db.query(`
    INSERT OR IGNORE INTO btcc_records (record_id, kind, sha256, content_json)
    VALUES (?, 'final_payload', ?, ?)
  `).run(
    delivery.payloadId,
    delivery.payloadSha256,
    stableJson(finalPayload),
  );
  if (!existingOutbox) {
    db.query(`
      INSERT INTO btcc_delivery_outbox (
        outbox_id, turn_id, committed_turn_revision, payload_id, payload_sha256,
        expected_message_id, content, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      delivery.outboxId,
      turn.turn_id,
      revision,
      delivery.payloadId,
      delivery.payloadSha256,
      delivery.expectedMessageId,
      delivery.content,
      delivered ? "observed" : "pending",
    );
  } else if (delivered) {
    db.query(`
      UPDATE btcc_delivery_outbox SET status = 'observed'
      WHERE outbox_id = ?
    `).run(delivery.outboxId);
  } else if (
    existingOutbox.status !== "pending" &&
    existingOutbox.status !== "inserted"
  ) {
    db.query(`
      UPDATE btcc_delivery_outbox SET status = 'pending'
      WHERE outbox_id = ?
    `).run(delivery.outboxId);
  }
  if (delivered) {
    db.query(`
      INSERT OR IGNORE INTO btcc_canonical_deliveries (
        turn_id, outbox_id, assistant_message_id, inserted_at
      ) VALUES (?, ?, ?, ?)
    `).run(
      turn.turn_id,
      delivery.outboxId,
      canonicalMessageId,
      new Date().toISOString(),
    );
  }

  const updated = db.query<{ turn_id: string }, [
    string,
    string | null,
    string,
    string,
    string | null,
    number,
    number,
    string,
    string,
    number,
    number,
    string | null,
  ]>(`
    UPDATE btcc_turns SET semantic_state = ?,
      active_checkpoint_id = ?, route = 'assisted', final_payload_json = ?,
      delivery_outbox_id = ?, canonical_assistant_message_id = ?,
      revision = ?, execution_fence = ?, final_disposition = 'completed'
    WHERE turn_id = ? AND semantic_state = ? AND revision = ?
      AND execution_fence = ? AND active_checkpoint_id IS ?
    RETURNING turn_id
  `).get(
    delivered ? "delivered" : "delivery_committed",
    checkpointId,
    stableJson(finalPayload),
    delivery.outboxId,
    delivered ? canonicalMessageId : null,
    revision,
    fence,
    turn.turn_id,
    turn.semantic_state,
    turn.revision,
    turn.execution_fence,
    turn.active_checkpoint_id,
  );
  if (updated?.turn_id !== turn.turn_id) {
    throw new Error(`Quarantined legacy Turn settlement lost CAS: ${turn.turn_id}`);
  }
  db.query(`
    UPDATE btcc_checkpoints SET is_active = 0, active_claim_id = NULL
    WHERE turn_id = ? AND is_active = 1
  `).run(turn.turn_id);
  db.query(`
    UPDATE btcc_state_claims SET status = 'consumed'
    WHERE turn_id = ? AND status != 'consumed'
  `).run(turn.turn_id);
  if (checkpointId) {
    db.query(`
      INSERT INTO btcc_checkpoints (
        checkpoint_id, turn_id, turn_revision, semantic_state, kind,
        checkpoint_revision, active_claim_id, is_active
      ) VALUES (?, ?, ?, 'delivery_committed', 'runtime', 0, NULL, 1)
    `).run(checkpointId, turn.turn_id, revision);
  }
}

function existingCanonicalMessageId(
  db: Database,
  turn: LegacyTurnRow,
  outbox: ExistingOutbox | null,
): string | null {
  const candidates = [
    turn.canonical_assistant_message_id,
    outbox?.expected_message_id,
  ].filter((value): value is string => Boolean(value));
  for (const messageId of candidates) {
    const message = db.query<{ role: string }, [string, string]>(`
      SELECT role FROM btcc_messages WHERE message_id = ? AND turn_id = ?
    `).get(messageId, turn.turn_id);
    if (message?.role === "assistant") return messageId;
  }
  return null;
}

function deliveryFromExistingOutbox(outbox: ExistingOutbox) {
  return {
    outboxId: outbox.outbox_id,
    payloadId: outbox.payload_id,
    payloadSha256: outbox.payload_sha256,
    expectedMessageId: outbox.expected_message_id,
    content: outbox.content,
  };
}

function deliveryForCanonicalMessage(
  db: Database,
  turn: LegacyTurnRow,
  revision: number,
  messageId: string,
) {
  const content = db.query<{ content: string }, [string]>(`
    SELECT content FROM btcc_messages WHERE message_id = ?
  `).get(messageId)?.content ?? limitationMessage(turn.original_message);
  return newDelivery(turn.turn_id, revision, content, messageId);
}

function limitationDelivery(turn: LegacyTurnRow, revision: number) {
  return newDelivery(
    turn.turn_id,
    revision,
    limitationMessage(turn.original_message),
  );
}

function newDelivery(
  turnId: string,
  revision: number,
  content: string,
  expectedMessageId?: string,
) {
  const payloadBody = {
    turnId,
    contentSha256: digest(content),
    route: "assisted",
    disposition: "completed",
    content,
  };
  const payloadSha256 = digest(stableJson(payloadBody));
  const payloadId = digest(`btcc-payload.v1\0${payloadSha256}`);
  const outboxId = digest(
    `btcc-r3-quarantine-delivery.v1\0${turnId}\0${revision}\0${payloadSha256}`,
  );
  return {
    outboxId,
    payloadId,
    payloadSha256,
    expectedMessageId:
      expectedMessageId ?? digest(`btcc-assistant-message.v1\0${outboxId}`),
    content,
  };
}

function limitationMessage(originalMessage: string): string {
  return /[가-힣]/u.test(originalMessage)
    ? "이 요청은 이전 BTCC 실행에서 중단되었습니다. 이전 실행의 도구나 외부 효과를 자동으로 반복하지 않았습니다. 새 메시지로 이어서 요청하시면 저장된 Work와 확인된 결과를 바탕으로 계속 진행하겠습니다."
    : "This request stopped in the previous BTCC runtime. I did not automatically repeat its tools or external effects. Send a new message to continue from the saved Work and verified results.";
}
