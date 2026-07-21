import type { BtccTurnOutcome } from "../contracts.ts";
import type { TurnRecord } from "./contracts.ts";

export function projectTerminalOutcome(turn: TurnRecord): BtccTurnOutcome {
  if (turn.semanticState === "cancelled") {
    return { kind: "cancelled", turnId: turn.turnId };
  }
  if (!turn.canonicalAssistantMessageId || !turn.finalPayload) {
    throw new Error("Delivered BTCC Turn is missing its canonical delivery");
  }
  return {
    kind: "delivered",
    turnId: turn.turnId,
    messageId: turn.canonicalAssistantMessageId,
    content: turn.finalPayload.content,
  };
}
