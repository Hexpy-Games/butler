import type { TurnRecord } from "../turn/index.ts";

export interface LearningSourceScheduler {
  schedule(turn: TurnRecord): void;
}

export function scheduleLearningSource(input: {
  turn: TurnRecord;
  scheduler: LearningSourceScheduler;
}): void {
  if (input.turn.semanticState !== "delivered" || !input.turn.finalPayload) return;
  input.scheduler.schedule(input.turn);
}
