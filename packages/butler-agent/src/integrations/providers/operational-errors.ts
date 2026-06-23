import { isRuntimeCancellationFailure } from "../../agent/turn/runtime-cancellation.ts";
import type { RuntimeFailureDiagnostic } from "./provider-errors.ts";

export function safeOperationalRuntimeFailure(input: {
  code?: string;
  message: string;
}): RuntimeFailureDiagnostic | null {
  const { code, message } = input;
  if (isRuntimeCancellation({ code, message })) {
    return {
      code: "turn_cancelled",
      message: "Butler turn was cancelled.",
      retryable: false,
      cause: safeOperationalErrorText(message),
    };
  }
  if (code === "turn_hard_timeout" || code === "hard_timeout" || /hard timeout|turn exceeded .*timeout/iu.test(message)) {
    return {
      code: code === "hard_timeout" ? "hard_timeout" : "turn_hard_timeout",
      message: "Butler hit the hard timeout before the turn completed.",
      retryable: false,
      cause: safeOperationalErrorText(message),
    };
  }
  if (
    code === "service_communication_error" ||
    code === "service_communication_failed" ||
    code === "app_service_communication_error" ||
    /app gateway service communication|service communication failed|could not communicate with the app service/iu.test(message)
  ) {
    return {
      code: normalizeOperationalCode(code, "service_communication_error"),
      message: "Butler could not communicate with the app service.",
      retryable: false,
      cause: safeOperationalErrorText(message),
    };
  }
  if (
    code === "runtime_storage_unavailable" ||
    code === "storage_unavailable" ||
    code === "runtime_storage_corrupt" ||
    code === "storage_corrupt" ||
    /runtime storage|storage (?:is )?(?:unavailable|corrupt)|database unavailable|sqlite/iu.test(message)
  ) {
    return {
      code: code && /corrupt/u.test(code) ? code : normalizeOperationalCode(code, "runtime_storage_unavailable"),
      message: "Butler runtime storage is unavailable.",
      retryable: false,
      cause: safeOperationalErrorText(message),
    };
  }
  if (
    code === "policy_denied" ||
    code === "policy_denial" ||
    code === "policy_violation" ||
    /policy (?:denied|denial|violation|blocked|rejected)|denied by policy/iu.test(message)
  ) {
    return {
      code: normalizeOperationalCode(code, "policy_denied"),
      message: "Butler policy denied this operation.",
      retryable: false,
      cause: safeOperationalErrorText(message),
    };
  }
  return null;
}

function isRuntimeCancellation(input: { code?: string; message: string }): boolean {
  return isRuntimeCancellationFailure(input);
}

function normalizeOperationalCode(code: string | undefined, fallback: string): string {
  return code?.trim() || fallback;
}

function safeOperationalErrorText(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : "";
  const normalized = text
    .replace(/\b(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/giu, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized ? normalized.slice(0, 500) : undefined;
}
