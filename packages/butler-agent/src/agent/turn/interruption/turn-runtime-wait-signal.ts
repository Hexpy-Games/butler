export const TURN_RUNTIME_WAIT_SIGNAL_CODE = "turn_waiting_runtime" as const;

export class TurnRuntimeWaitSignal extends Error {
  readonly code = TURN_RUNTIME_WAIT_SIGNAL_CODE;

  constructor(
    readonly turnId: string,
    readonly recoveryCaseId: string,
  ) {
    super("The logical turn is waiting for runtime recovery ownership.");
    this.name = "TurnRuntimeWaitSignal";
  }
}

export function isTurnRuntimeWaitSignal(
  value: unknown,
): value is TurnRuntimeWaitSignal {
  return value instanceof TurnRuntimeWaitSignal || Boolean(
    value && typeof value === "object" &&
    (value as { code?: unknown }).code === TURN_RUNTIME_WAIT_SIGNAL_CODE &&
    typeof (value as { turnId?: unknown }).turnId === "string" &&
    typeof (value as { recoveryCaseId?: unknown }).recoveryCaseId === "string",
  );
}
