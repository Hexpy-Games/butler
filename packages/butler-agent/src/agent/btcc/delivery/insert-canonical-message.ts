import type { TurnRecord } from "../turn/index.ts";

export interface CanonicalMessageStore {
  insertCanonicalAssistantMessage(input: {
    turnId: string;
    sessionId: string;
    outboxId: string;
    expectedMessageId: string;
    payloadRef: { id: string; sha256: string };
    content: string;
  }): Promise<{ messageId: string }>;
}

export async function insertCanonicalMessage(input: {
  turn: TurnRecord;
  messages: CanonicalMessageStore;
}): Promise<{ messageId: string }> {
  const outbox = input.turn.deliveryOutbox;
  if (!outbox || !input.turn.openingAnswer) {
    throw new Error("BTCC delivery_committed Turn has no immutable Outbox payload");
  }
  return input.messages.insertCanonicalAssistantMessage({
    turnId: input.turn.turnId,
    sessionId: input.turn.sessionId,
    outboxId: outbox.outboxId,
    expectedMessageId: outbox.expectedMessageId,
    payloadRef: outbox.finalPayloadRef,
    content: outbox.content,
  });
}
