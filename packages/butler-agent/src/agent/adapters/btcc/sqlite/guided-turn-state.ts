import type {
  AcceptedTurnTransition,
  TurnSemanticState,
} from "../../../btcc/index.ts";

export const GUIDED_TURN_STATES = [
  "admitted",
  "delivery_committed",
  "delivered",
  "cancelled",
] as const satisfies readonly TurnSemanticState[];

export type GuidedTurnSemanticState = typeof GUIDED_TURN_STATES[number];

export type GuidedTurnTransition = Extract<
  AcceptedTurnTransition,
  { kind: "accept_guided_final" | "observe_delivery" }
>;

const guidedTurnStates = new Set<string>(GUIDED_TURN_STATES);

export function assertGuidedTurnSemanticState(
  state: string,
): asserts state is GuidedTurnSemanticState {
  if (!guidedTurnStates.has(state)) {
    throw new Error(`BTCC R3 rejects legacy semantic state: ${state}`);
  }
}

export function assertGuidedTurnTransition(
  transition: AcceptedTurnTransition,
): asserts transition is GuidedTurnTransition {
  const kind = (transition as { kind: string }).kind;
  if (
    kind !== "accept_guided_final" &&
    kind !== "observe_delivery"
  ) {
    throw new Error(`BTCC R3 does not support transition: ${kind}`);
  }
}
