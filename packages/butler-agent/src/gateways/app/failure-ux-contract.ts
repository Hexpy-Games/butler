import {
  recoverableLimitedDeliveryForError,
  type RecoverableLimitedDelivery,
} from "../../agent/turn/recoverable-delivery.ts";
import { safeLimitationText } from "../../agent/turn/runtime-delivery-state.ts";
import { safeRuntimeFailure } from "../../integrations/providers/provider-errors.ts";
import {
  INTERNAL_RECOVERY_REQUIRED_CODE,
  isCompletionObligationProtocolMessage,
  isInternalRecoveryFailure,
} from "../../runtime/internal-recovery-failure.ts";

export interface AppResponderSafeError {
  code: string;
  message: string;
  cause?: string;
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
  if (isInternalRecoveryFailure(error)) {
    const message = appErrorMessage(error);
    const runtimeFailure = safeRuntimeFailure(error);
    return {
      code: INTERNAL_RECOVERY_REQUIRED_CODE,
      message:
        internalRecoveryMessage(message, runtimeFailure.message) ??
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
      cause: safeResponderCause(runtimeFailure.cause),
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

function safeGoalCompletionIncompleteMessage(message: string): string | null {
  if (isCompletionObligationProtocolMessage(message)) {
    return "진행한 내용은 보존했습니다. 다만 마지막 마무리 단계까지 완전히 닫지는 못했습니다.";
  }
  const safe = safeLimitationText(message, "");
  return safe || null;
}

function internalRecoveryMessage(rawMessage: string, safeRuntimeMessage: string): string | null {
  if (/prompt usage model-call budget exhausted/iu.test(rawMessage)) {
    return "진행한 내용은 보존했습니다. 다음 요청에서 남은 작업을 이어갈 수 있습니다.";
  }
  if (isCompletionObligationProtocolMessage(rawMessage)) {
    return safeGoalCompletionIncompleteMessage(rawMessage);
  }
  if (
    safeRuntimeMessage &&
    safeRuntimeMessage !== "Butler could not verify that the requested goal was completed." &&
    safeRuntimeMessage !== rawMessage
  ) {
    return safeRuntimeMessage;
  }
  return safeGoalCompletionIncompleteMessage(rawMessage);
}

function appErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    return typeof message === "string" ? message : "";
  }
  return typeof error === "string" ? error : "";
}

function safeResponderCause(value: unknown): string | undefined {
  const safe = safeLimitationText(value, "");
  return safe || undefined;
}
