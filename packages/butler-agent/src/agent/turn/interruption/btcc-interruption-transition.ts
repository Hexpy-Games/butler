import type { BtccTurnState } from "./turn-interruption-types.ts";

const ACTIVE_BTCC_STATES = new Set<BtccTurnState>([
  "accepted",
  "model_deciding",
  "announcing_intent",
  "executing_tools",
  "observing_tools",
  "continuing",
]);

export function assertBtccInterruptionTransition(
  from: BtccTurnState,
  to: BtccTurnState,
): void {
  if (from === "delivered" || from === "cancelled") {
    throw new Error("btcc_turn_terminal_immutable");
  }
  if (to === "cancelled") return;
  if (!ACTIVE_BTCC_STATES.has(from)) {
    throw new Error(`btcc_turn_wait_requires_resume_receipt:${from}:${to}`);
  }
  if (
    to !== "continuing" &&
    to !== "waiting_user" &&
    to !== "waiting_external" &&
    to !== "waiting_runtime"
  ) {
    throw new Error(`btcc_turn_interruption_transition_invalid:${from}:${to}`);
  }
}
