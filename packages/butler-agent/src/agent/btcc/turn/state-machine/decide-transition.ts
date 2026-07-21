import { createHash } from "node:crypto";
import type {
  AcceptedTurnTransition,
  TurnEvent,
  TurnRecord,
} from "../contracts.ts";

export function decideTransition(
  turn: TurnRecord,
  event: TurnEvent,
): AcceptedTurnTransition {
  if (turn.semanticState === "admitted" && event.kind === "TurnActivated") {
    return {
      kind: "activate_opening",
      successor: "conception_opening",
      successorCheckpointKind: "phase",
    };
  }
  if (
    turn.semanticState === "conception_opening" &&
    event.kind === "OpeningAnswerAccepted"
  ) {
    const committedRevision = turn.revision + 1;
    const payload = event.product.finalPayload;
    const outboxId = digest(
      `btcc-canonical-delivery.v1\0${turn.turnId}\0${committedRevision}\0${payload.ref.sha256}`,
    );
    return {
      kind: "accept_opening_answer",
      successor: "delivery_committed",
      successorCheckpointKind: "runtime",
      product: event.product,
      deliveryOutbox: {
        outboxId,
        finalPayloadRef: payload.ref,
        expectedMessageId: digest(`btcc-assistant-message.v1\0${outboxId}`),
        content: payload.content,
        status: "pending",
      },
    };
  }
  if (
    turn.semanticState === "delivery_committed" &&
    event.kind === "DeliveryObserved" &&
    event.assistantMessageId === turn.deliveryOutbox?.expectedMessageId
  ) {
    return {
      kind: "observe_delivery",
      successor: "delivered",
      assistantMessageId: event.assistantMessageId,
    };
  }
  throw new Error(`BTCC state/event mismatch: ${turn.semanticState}/${event.kind}`);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
