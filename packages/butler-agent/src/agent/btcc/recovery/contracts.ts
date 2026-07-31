import type { TurnSemanticState } from "../turn/contracts.ts";

export type ExecutionPermit = {
  signal: AbortSignal;
  assertActive(): void;
  close(): void;
};

export interface TurnExecutionSupervisor {
  enter(input: {
    turnId: string;
    executionFence: number;
    semanticState: TurnSemanticState;
  }): ExecutionPermit;
  installStop(turnId: string): void;
  allowFinalizing(turnId: string): void;
}

export interface CommittedSuccessorReadiness {
  waitForStorageReadiness(signal: AbortSignal): Promise<void>;
}
