import type { TurnSemanticState } from "../turn/index.ts";

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
