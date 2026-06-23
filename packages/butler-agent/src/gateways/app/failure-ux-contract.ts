import {
  recoverableLimitedDeliveryForError,
  type RecoverableLimitedDelivery,
} from "../../agent/turn/recoverable-delivery.ts";
import { safeLimitationText } from "../../agent/turn/runtime-delivery-state.ts";
import { safeRuntimeFailure } from "../../integrations/providers/provider-errors.ts";

export interface AppResponderSafeError {
  code: string;
  message: string;
}

export type AppLimitedDelivery = RecoverableLimitedDelivery;

export function appLimitedDeliveryForError(error: unknown): RecoverableLimitedDelivery | null {
  return recoverableLimitedDeliveryForError(error);
}

export function appSafeResponderError(error: unknown): AppResponderSafeError {
  const timeout = appResponderTimeout(error);
  if (timeout) return timeout;
  if (isLocalModelEmptyResponseError(error)) {
    return {
      code: "provider_empty_response",
      message:
        "The selected model returned no visible answer. Retry the turn or switch models.",
    };
  }
  if (isGoalCompletionIncompleteError(error)) {
    return {
      code: "internal_recovery_required",
      message:
        safeGoalCompletionIncompleteMessage(error.message) ??
        "Butler could not verify that the requested goal was completed.",
    };
  }
  const runtimeFailure = safeRuntimeFailure(error);
  if (
    runtimeFailure.code !== "gateway_failed" ||
    runtimeFailure.message !== "Butler could not complete this turn."
  ) {
    return {
      code: runtimeFailure.code,
      message: runtimeFailure.message,
    };
  }
  return {
    code: "gateway_failed",
    message: "Butler could not complete this turn.",
  };
}

function appResponderTimeout(error: unknown): AppResponderSafeError | null {
  if (!(error instanceof Error)) return null;
  if (error.name !== "AppResponderTimeoutError") return null;
  const record = error as Error & { code?: unknown };
  const code = record.code === "gateway_timeout"
    ? record.code
    : "gateway_timeout";
  return {
    code,
    message:
      "Butler did not finish the turn before the app timeout.",
  };
}

function isLocalModelEmptyResponseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /Local model API returned no (?:visible )?(?:final )?text output/iu.test(
    error.message,
  );
}

function isGoalCompletionIncompleteError(error: unknown): error is Error {
  return (
    error instanceof Error && error.name === "GoalCompletionIncompleteError"
  );
}

function safeGoalCompletionIncompleteMessage(message: string): string | null {
  if (isCompletionObligationProtocolMessage(message)) {
    return "요청한 결과를 완료했는지 확인하지 못했습니다. 작업을 다시 시도할 수 있습니다.";
  }
  const safe = safeLimitationText(message, "");
  return safe || null;
}

function isCompletionObligationProtocolMessage(message: string): boolean {
  return /(?:unsatisfied|missing|unresolved) public completion obligation/iu
    .test(message);
}
