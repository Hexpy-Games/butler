import type { BtccTurnOutcome } from "../../../agent/btcc/index.ts";

export function projectTurnOutcome(outcome: BtccTurnOutcome): { text: string } {
  if (outcome.kind === "delivered" || outcome.kind === "already_delivered") {
    return { text: outcome.content };
  }
  if (outcome.kind === "cancelled" || outcome.kind === "already_cancelled") {
    return { text: "" };
  }
  throw new Error(`BTCC inbound did not reach a deliverable outcome: ${outcome.kind}`);
}
