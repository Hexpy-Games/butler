import type { ModelRequestAdmissionReceipt } from "./shared/request-context-admission.ts";

export interface RuntimeFailureDiagnostic {
  code: string;
  message: string;
  provider?: string;
  api?: string;
  statusCode?: number;
  endpoint?: string;
  model?: string;
  retryable?: boolean;
  cause?: string;
  requestGeneration?: number;
  measuredInputTokens?: number;
  registeredInputCapacity?: number;
  requestHash?: string;
  timeoutKind?: "total" | "idle";
}

export class ModelProviderRequestError extends Error {
  readonly code: string;
  readonly provider: string;
  readonly api: string;
  readonly statusCode?: number;
  readonly endpoint?: string;
  readonly model?: string;
  readonly retryable: boolean;
  readonly causeMessage?: string;
  readonly requestGeneration?: number;
  readonly measuredInputTokens?: number;
  readonly registeredInputCapacity?: number;
  readonly requestHash?: string;
  readonly timeoutKind?: "total" | "idle";

  constructor(input: RuntimeFailureDiagnostic) {
    super(input.message);
    this.name = "ModelProviderRequestError";
    this.code = input.code;
    this.provider = input.provider ?? "model-provider";
    this.api = input.api ?? "model-api";
    this.statusCode = input.statusCode;
    this.endpoint = input.endpoint;
    this.model = input.model;
    this.retryable = input.retryable ?? false;
    this.causeMessage = safeErrorText(input.cause);
    this.requestGeneration = input.requestGeneration;
    this.measuredInputTokens = input.measuredInputTokens;
    this.registeredInputCapacity = input.registeredInputCapacity;
    this.requestHash = input.requestHash;
    this.timeoutKind = input.timeoutKind;
  }

  diagnostic(): RuntimeFailureDiagnostic {
    return {
      code: this.code,
      message: this.message,
      provider: this.provider,
      api: this.api,
      statusCode: this.statusCode,
      endpoint: this.endpoint,
      model: this.model,
      retryable: this.retryable,
      cause: this.causeMessage,
      requestGeneration: this.requestGeneration,
      measuredInputTokens: this.measuredInputTokens,
      registeredInputCapacity: this.registeredInputCapacity,
      requestHash: this.requestHash,
      timeoutKind: this.timeoutKind,
    };
  }
}

export function providerRoundTimeoutError(input: {
  provider: string;
  api: string;
  timeoutKind: "total" | "idle";
  endpoint?: string;
  model?: string;
}): ModelProviderRequestError {
  const label = providerLabel(input.provider);
  return new ModelProviderRequestError({
    code: "provider_round_timeout",
    message: `${label} stopped making forward progress. Butler preserved the current turn checkpoint and will continue after provider recovery.`,
    provider: input.provider,
    api: input.api,
    endpoint: input.endpoint,
    model: input.model,
    retryable: true,
    timeoutKind: input.timeoutKind,
  });
}

export function isAdmissionInvariantViolation(
  error: unknown,
): error is ModelProviderRequestError {
  return (
    error instanceof ModelProviderRequestError &&
    error.code === "admission_invariant_violation"
  );
}

export function providerHttpError(input: {
  provider: string;
  api: string;
  statusCode: number;
  detail?: string;
  endpoint?: string;
  model?: string;
  admission?: ModelRequestAdmissionReceipt;
}): ModelProviderRequestError {
  const status = input.statusCode;
  const detail = safeErrorText(input.detail);
  const contextLimitExceeded = isContextLimitDetail(detail);
  const code = contextLimitExceeded
    ? input.admission
      ? "admission_invariant_violation"
      : "provider_context_limit_exceeded"
    : status === 401 || status === 403
      ? "provider_auth_error"
      : status === 429
        ? "provider_rate_limited"
        : "provider_api_error";
  const label = providerLabel(input.provider);
  const message =
    code === "admission_invariant_violation"
      ? `${label} rejected a request that passed local context admission. The turn must be rebuilt from canonical state.`
      : code === "provider_context_limit_exceeded"
        ? `${label} context limit was exceeded. Compact or reduce the session context, then retry.`
        : code === "provider_auth_error"
          ? `${label} authentication failed with HTTP ${status}. Check the configured provider credentials.`
          : code === "provider_rate_limited"
            ? `${label} API rate limit hit with HTTP ${status}. Retry after provider readiness.`
            : `${label} API request failed with HTTP ${status}.`;
  return new ModelProviderRequestError({
    code,
    message,
    provider: input.provider,
    api: input.api,
    statusCode: status,
    endpoint: input.endpoint,
    model: input.model,
    retryable:
      code !== "admission_invariant_violation" &&
      (contextLimitExceeded || status === 429 || status >= 500),
    cause: detail,
    requestGeneration: input.admission?.plan.generation,
    measuredInputTokens: input.admission?.plan.compiled_input_tokens,
    registeredInputCapacity: input.admission?.plan.input_capacity_tokens,
    requestHash: input.admission?.serialized_request_sha256,
  });
}

export function providerNetworkError(input: {
  provider: string;
  api: string;
  error: unknown;
  endpoint?: string;
  model?: string;
}): ModelProviderRequestError {
  const label = providerLabel(input.provider);
  return new ModelProviderRequestError({
    code: "provider_network_error",
    message: `${label} API connection failed before a response was received.`,
    provider: input.provider,
    api: input.api,
    endpoint: input.endpoint,
    model: input.model,
    retryable: true,
    cause: safeErrorText(errorMessage(input.error)),
  });
}

export function providerEmptyResponseError(input: {
  provider: string;
  api: string;
  endpoint?: string;
  model?: string;
  local?: boolean;
}): ModelProviderRequestError {
  const label = input.local
    ? "The selected local model"
    : providerLabel(input.provider);
  return new ModelProviderRequestError({
    code: "provider_empty_response",
    message: `${label} returned no visible answer. Butler preserved the turn for provider recovery.`,
    provider: input.provider,
    api: input.api,
    endpoint: input.endpoint,
    model: input.model,
    retryable: true,
  });
}

export function safeEndpointLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.replace(/[?#].*$/u, "");
  }
}

export function safeErrorText(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : "";
  const normalized = text
    .replace(
      /\b(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/giu,
      "[redacted]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized ? normalized.slice(0, 500) : undefined;
}

function providerLabel(provider: string): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "openai-codex") return "OpenAI Codex";
  if (provider === "local") return "Local model";
  return "Model provider";
}

function isContextLimitDetail(detail: string | undefined): boolean {
  if (!detail) return false;
  return /(?:available context size|context (?:size|window|length)|maximum context|too many tokens|request \(\d+ tokens\) exceeds|input tokens? exceed)/iu.test(
    detail,
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    return typeof message === "string" ? message : "Unknown runtime error";
  }
  return typeof error === "string" ? error : "Unknown runtime error";
}
