import {
  providerNetworkError,
  safeRuntimeFailure,
} from "../../../../integrations/providers/provider-errors.ts";
import { safeLimitationText } from "../core/projection-safe-values.ts";
import type { AppProjectionDeliveryState } from "./btcc-public-projection.ts";

export interface AppResponderSafeError {
  code: string;
  message: string;
  cause?: string;
}

export interface AppLimitedDelivery {
  text: string | null;
  reason: string;
  delivery: {
    delivery_state: AppProjectionDeliveryState;
    terminal: boolean;
    issue_kind: string;
    visibility: string;
    failure_notice: boolean;
    limitation_codes: string[];
    limitations: string[];
  };
}

export function appSafeResponderError(error: unknown): AppResponderSafeError {
  if (error instanceof Error && error.name === "AppResponderTimeoutError") {
    return {
      code: "gateway_timeout",
      message: "Butler did not finish the turn before the app timeout.",
    };
  }
  if (error && typeof error === "object") {
    const code = (error as Record<string, unknown>).code;
    if (code === "runtime_fault" || code === "runtime_invariant_violation") {
      return {
        code,
        message: "Butler runtime was interrupted before the turn could continue.",
      };
    }
  }
  if (isUnownedResponderAbort(error)) {
    const failure = providerNetworkError({
      provider: "model-provider",
      api: "model-api",
      error,
    }).diagnostic();
    return {
      code: failure.code,
      message: failure.message,
      ...(safeResponderCause(failure.cause)
        ? { cause: safeResponderCause(failure.cause) }
        : {}),
    };
  }
  const failure = safeRuntimeFailure(error);
  return {
    code: failure.code,
    message: failure.message,
    ...(safeResponderCause(failure.cause)
      ? { cause: safeResponderCause(failure.cause) }
      : {}),
  };
}

function isUnownedResponderAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; name?: unknown };
  return record.code === "ABORT_ERR" || record.name === "AbortError";
}

function safeResponderCause(value: unknown): string | undefined {
  const safe = safeLimitationText(value, "");
  return safe || undefined;
}
