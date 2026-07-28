import type { ModelPhaseState } from "./contracts.ts";
import type { OperationRequest } from "./contracts.ts";
import type { PhaseRunBinding } from "./contracts.ts";

export type PublicPhaseActivity = {
  summary: string;
  rationale: string;
  nextStep: string;
};

export interface PhaseActivityPublisher {
  publish(update: {
    turnId: string;
    semanticState: ModelPhaseState;
    activityId: string;
    activity: PublicPhaseActivity;
  }): void | Promise<void>;
  modelRoundWaiting?(update: {
    turnId: string;
    semanticState: ModelPhaseState;
    checkpointId: string;
  }): void | Promise<void>;
  operationChanged?(update: {
    turnId: string;
    semanticState: ModelPhaseState;
    request: OperationRequest;
    activityId: string;
    status: "started" | "completed" | "failed" | "cancelled";
    resultRef?: { id: string; sha256: string };
    byteLength?: number;
  }): void | Promise<void>;
}

export function phaseActivityId(binding: PhaseRunBinding): string {
  return `phase-activity:${binding.checkpointId}:${binding.checkpointRevision}`;
}
