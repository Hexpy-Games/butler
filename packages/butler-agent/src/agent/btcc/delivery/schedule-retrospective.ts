import type { TurnRecord } from "../turn/index.ts";

export interface RetrospectiveScheduler {
  schedule(turn: TurnRecord): void;
}

export function scheduleRetrospective(input: {
  turn: TurnRecord;
  scheduler: RetrospectiveScheduler;
}): void {
  if (input.turn.semanticState !== "delivered" || !input.turn.finalPayload) return;
  try {
    input.scheduler.schedule(input.turn);
  } catch {
    // Delivery is authoritative; durable reconciliation discovers a missed source later.
  }
}
