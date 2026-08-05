import { safeOperationalRuntimeFailure } from "./operational-errors.ts";
import {
  INTERNAL_RECOVERY_REQUIRED_CODE,
  isInternalRecoveryFailure,
  isToolCallRepairFailure,
  safeInternalRecoveryMessage,
} from "../../runtime/internal-recovery-failure.ts";
import {
  ModelProviderRequestError,
  providerEmptyResponseError,
  providerHttpError,
  providerNetworkError,
  safeErrorText,
  type RuntimeFailureDiagnostic,
} from "./provider-request-errors.ts";

export function safeRuntimeFailure(error: unknown): RuntimeFailureDiagnostic {
  if (error instanceof ModelProviderRequestError) return error.diagnostic();
  const message = errorMessage(error);
  const code = errorCode(error);
  if (code === "turn_contract_surface_inconsistent") {
    return {
      code,
      message:
        "Butler could not create a valid tool path for this request. Retry the turn.",
      retryable: true,
      cause: safeErrorText(message),
    };
  }
  if (
    code === "grounding_review_structured_output_invalid" ||
    code === "grounding_review_structured_transport_missing"
  ) {
    return {
      code,
      message:
        "Butler could not verify the public grounding contract. Retry the turn.",
      retryable: true,
      cause: safeErrorText(message),
    };
  }
  if (code === "prompt_usage_model_call_budget_exhausted") {
    return {
      code,
      message:
        "Butler reached the turn execution budget before it could continue. Retry the turn.",
      retryable: true,
      cause: safeErrorText(message),
    };
  }
  if (isToolCallRepairFailure(error)) {
    return {
      code: code ?? "tool_call_repair",
      message:
        safeErrorText(message) ??
        "Butler needs to retry the tool call with corrected arguments.",
      retryable: true,
      cause: safeErrorText(message),
    };
  }
  if (isInternalRecoveryFailure(error)) {
    const safeMessage = safeInternalRecoveryMessage(message);
    return {
      code: INTERNAL_RECOVERY_REQUIRED_CODE,
      message: safeMessage,
      retryable: true,
      cause: safeMessage,
    };
  }
  const operationalFailure = safeOperationalRuntimeFailure({ code, message });
  if (operationalFailure) return operationalFailure;
  return (
    normalizeLegacyProviderFailure(message) ?? {
      code: "gateway_failed",
      message: "Butler could not complete this turn.",
      retryable: true,
      cause: safeErrorText(message),
    }
  );
}

export function diagnosticDetails(error: unknown): Record<string, unknown> {
  const diagnostic = safeRuntimeFailure(error);
  return Object.fromEntries(
    Object.entries({
      code: diagnostic.code,
      provider: diagnostic.provider,
      api: diagnostic.api,
      status_code: diagnostic.statusCode,
      endpoint: diagnostic.endpoint,
      model: diagnostic.model,
      retryable: diagnostic.retryable,
      cause: diagnostic.cause,
      provider_error_code: diagnostic.providerErrorCode,
      provider_error_type: diagnostic.providerErrorType,
      provider_error_details: diagnostic.providerErrorDetails,
    }).filter(([, value]) => value !== undefined && value !== ""),
  );
}

function normalizeLegacyProviderFailure(
  message: string,
): RuntimeFailureDiagnostic | undefined {
  const status = statusCodeFromMessage(message);
  if (
    /Local model API returned no (?:visible )?(?:final )?(?:text output|answer envelope)/iu.test(
      message,
    )
  ) {
    return providerEmptyResponseError({
      provider: "local",
      api: "chat_completions",
      local: true,
    }).diagnostic();
  }
  if (/OpenAI Responses API returned no text output/iu.test(message)) {
    return providerEmptyResponseError({
      provider: "openai",
      api: "responses",
    }).diagnostic();
  }
  if (/Local model API error/iu.test(message) && status) {
    return providerHttpError({
      provider: "local",
      api: "chat_completions",
      statusCode: status,
      detail: message,
    }).diagnostic();
  }
  if (
    /(?:OpenAI Responses API error|Codex backend error)/iu.test(message) &&
    status
  ) {
    return providerHttpError({
      provider: /Codex backend error/iu.test(message)
        ? "openai-codex"
        : "openai",
      api: /Codex backend error/iu.test(message)
        ? "codex_responses"
        : "responses",
      statusCode: status,
      detail: message,
    }).diagnostic();
  }
  if (
    /Unable to connect|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|network|connection termination|connection reset|remote connection reset|disconnect\/reset/iu.test(
      message,
    )
  ) {
    return providerNetworkError({
      provider: "model-provider",
      api: "model-api",
      error: message,
    }).diagnostic();
  }
  return undefined;
}

function statusCodeFromMessage(message: string): number | undefined {
  const match = message.match(/\((\d{3})\)|HTTP\s+(\d{3})|status\s+(\d{3})/iu);
  const value = Number(match?.[1] ?? match?.[2] ?? match?.[3]);
  return Number.isFinite(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    return typeof message === "string" ? message : "Unknown runtime error";
  }
  return typeof error === "string" ? error : "Unknown runtime error";
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}
