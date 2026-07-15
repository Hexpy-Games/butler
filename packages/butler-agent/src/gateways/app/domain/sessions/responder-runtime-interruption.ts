import { isTurnRuntimeWaitSignal } from "../../../../agent/turn/interruption/turn-runtime-wait-signal.ts";
import { isTurnSchedulerContinuationYieldError } from "../../../../agent/turn/turn-continuation-context.ts";
import { AppResponderTimeoutError } from "../../infrastructure/core/app-store-errors.ts";

/**
 * Maps typed, non-terminal responder control flow to the App waiting projection.
 * This intentionally does not inspect Error.name or message text.
 */
export function isResponderRuntimeInterruption(
  error: unknown,
): boolean {
  return isTurnRuntimeWaitSignal(error) ||
    isTurnSchedulerContinuationYieldError(error) ||
    error instanceof AppResponderTimeoutError;
}
