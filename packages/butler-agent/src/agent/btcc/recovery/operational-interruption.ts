import type { PhaseRunBinding } from "../core/index.ts";

export class OperationalInterruptionError extends Error {
  override readonly name = "OperationalInterruptionError";

  constructor(
    readonly code: string,
    readonly anchor: PhaseRunBinding,
  ) {
    super(`BTCC operational interruption: ${code}`);
  }
}

export function isBtccOperationalInterruption(
  error: unknown,
): error is OperationalInterruptionError {
  return error instanceof OperationalInterruptionError;
}
