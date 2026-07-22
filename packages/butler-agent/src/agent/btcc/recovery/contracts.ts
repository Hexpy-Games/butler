import type { TurnSemanticState } from "../turn/index.ts";
import type {
  OperationalCheckpointAnchor,
  OperationalInterruptionError,
} from "./operational-interruption.ts";

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

export type OperationalRecoveryReceipt = {
  interruptionId: string;
  activationCount: number;
};

export interface OperationalRecoveryStore {
  record(interruption: OperationalInterruptionError): Promise<OperationalRecoveryReceipt>;
  markReady(receipt: OperationalRecoveryReceipt): Promise<void>;
  pending(anchor: OperationalCheckpointAnchor): Promise<OperationalInterruptionError | null>;
  resolve(anchor: OperationalCheckpointAnchor): Promise<boolean>;
  pendingTurnIds(): Promise<string[]>;
}

export interface ProviderRecoveryReadiness {
  wait(input: {
    interruption: OperationalInterruptionError;
    receipt: OperationalRecoveryReceipt;
    signal: AbortSignal;
  }): Promise<void>;
}

export interface OperationalRecoveryBoundary {
  awaitReentry(
    interruption: OperationalInterruptionError,
    signal: AbortSignal,
  ): Promise<void>;
  pending(anchor: OperationalCheckpointAnchor): Promise<OperationalInterruptionError | null>;
  resolve(anchor: OperationalCheckpointAnchor): Promise<boolean>;
  pendingTurnIds(): Promise<string[]>;
}
