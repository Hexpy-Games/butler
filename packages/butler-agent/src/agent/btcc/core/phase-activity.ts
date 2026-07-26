import type { ModelPhaseState } from "./contracts.ts";
import type { OperationRequest } from "./contracts.ts";

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
  operationChanged?(update: {
    turnId: string;
    semanticState: ModelPhaseState;
    request: OperationRequest;
    status: "started" | "completed" | "failed" | "cancelled";
    resultRef?: { id: string; sha256: string };
    byteLength?: number;
  }): void | Promise<void>;
}
