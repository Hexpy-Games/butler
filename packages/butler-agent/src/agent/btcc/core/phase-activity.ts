import type { ModelPhaseState } from "./contracts.ts";

export type PublicPhaseActivity = {
  summary: string;
  rationale: string;
  nextStep: string;
};

export interface PhaseActivityPublisher {
  publish(update: {
    turnId: string;
    semanticState: ModelPhaseState;
    activity: PublicPhaseActivity;
  }): void | Promise<void>;
  modelRoundWaiting?(update: {
    turnId: string;
    semanticState: ModelPhaseState;
    checkpointId: string;
  }): void | Promise<void>;
}
