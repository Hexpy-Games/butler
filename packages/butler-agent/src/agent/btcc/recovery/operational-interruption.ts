export type OperationalCheckpointAnchor = {
  turnId: string;
  turnRevision: number;
  semanticState: string;
  checkpointId: string;
  checkpointRevision: number;
  claimId: string;
  executionFence: number;
};

export type OperationalActivation =
  | { kind: "automatic_provider_recovery" }
  | { kind: "provider_action_required" }
  | { kind: "runtime_remediation" }
  | { kind: "cancelled" };

export class OperationalInterruptionError extends Error {
  override readonly name = "OperationalInterruptionError";

  constructor(
    readonly code: string,
    readonly anchor: OperationalCheckpointAnchor,
    readonly activation: OperationalActivation = { kind: "runtime_remediation" },
  ) {
    super(`BTCC operational interruption: ${code}`);
  }
}

export function isBtccOperationalInterruption(
  error: unknown,
): error is OperationalInterruptionError {
  return error instanceof OperationalInterruptionError;
}
