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
  retryAt?: string;
  providerRequestId?: string;
  rateLimit?: ProviderRateLimitDiagnostic;
  providerErrorCode?: string;
  providerErrorType?: string;
  providerErrorDetails?: unknown;
}

/**
 * The stable, provider-declared portion of an HTTP error envelope.  Provider
 * adapters may use different envelope names, but route policy must only make
 * a fallback decision from these explicit fields, never from status alone.
 */
export interface ProviderStructuredError {
  code?: string;
  type?: string;
  message?: string;
  details?: unknown;
}

export type ProviderRateLimitDiagnostic = {
  retryAfter?: string;
  reset?: string;
  limit?: string;
  remaining?: string;
};

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
  readonly retryAt?: string;
  readonly providerRequestId?: string;
  readonly rateLimit?: ProviderRateLimitDiagnostic;
  readonly providerErrorCode?: string;
  readonly providerErrorType?: string;
  readonly providerErrorDetails?: unknown;

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
    this.retryAt = input.retryAt;
    this.providerRequestId = input.providerRequestId;
    this.rateLimit = input.rateLimit;
    this.providerErrorCode = safeProviderErrorIdentifier(input.providerErrorCode);
    this.providerErrorType = safeProviderErrorIdentifier(input.providerErrorType);
    this.providerErrorDetails = sanitizeProviderErrorValue(input.providerErrorDetails);
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
      retryAt: this.retryAt,
      providerRequestId: this.providerRequestId,
      rateLimit: this.rateLimit,
      providerErrorCode: this.providerErrorCode,
      providerErrorType: this.providerErrorType,
      providerErrorDetails: this.providerErrorDetails,
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
  providerError?: unknown;
  endpoint?: string;
  model?: string;
  admission?: ModelRequestAdmissionReceipt;
  headers?: Pick<Headers, "get">;
}): ModelProviderRequestError {
  const status = input.statusCode;
  const structured = extractProviderStructuredError(input.providerError);
  const detail = safeErrorText(input.detail ?? structured?.message);
  const normalizedProviderCode = normalizeProviderErrorCode(
    input.provider,
    structured,
  );
  const contextLimitExceeded = isContextLimitDetail(detail);
  const code = normalizedProviderCode
    ?? (contextLimitExceeded
      ? input.admission
        ? "admission_invariant_violation"
        : "provider_context_limit_exceeded"
      : status === 401 || status === 403
        ? "provider_auth_error"
        : status === 429
          ? "provider_rate_limited"
          : "provider_api_error");
  const label = providerLabel(input.provider);
  const message =
    code === "provider_quota_exhausted"
      ? `${label} reported that the configured quota, credit, or billing limit is exhausted.`
      : code === "provider_model_not_found"
        ? `${label} reported that the configured model was not found.`
        : code === "provider_model_retired"
          ? `${label} reported that the configured model is retired.`
          : code === "provider_model_unavailable"
            ? `${label} reported that the configured model is unavailable.`
            : code === "provider_unsupported_model"
              ? `${label} reported that the configured model is unsupported.`
              : code === "admission_invariant_violation"
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
      !normalizedProviderCode &&
      code !== "admission_invariant_violation" &&
      (contextLimitExceeded || status === 429 || status >= 500),
    cause: detail,
    requestGeneration: input.admission?.plan.generation,
    measuredInputTokens: input.admission?.plan.compiled_input_tokens,
    registeredInputCapacity: input.admission?.plan.input_capacity_tokens,
    requestHash: input.admission?.serialized_request_sha256,
    retryAt: providerRetryAt(input.headers),
    providerRequestId: providerRequestId(input.headers),
    rateLimit: providerRateLimit(input.headers),
    providerErrorCode: structured?.code,
    providerErrorType: structured?.type,
    providerErrorDetails: structured?.details,
  });
}

/**
 * Extracts the common error envelope used by OpenAI-compatible, Anthropic,
 * Gemini, and Codex responses.  Returning undefined for an unstructured body
 * is intentional: a status-only response is not evidence of a model or quota
 * failure.
 */
export function extractProviderStructuredError(
  value: unknown,
): ProviderStructuredError | undefined {
  const root = asRecord(value);
  if (!root) return undefined;
  const candidates: unknown[] = [
    root.error,
    asRecord(root.response)?.error,
    root,
  ];
  for (const candidate of candidates) {
    const record = asRecord(candidate);
    if (!record) continue;
    const code = safeProviderErrorIdentifier(
      firstString(record.code, record.error_code, record.errorCode),
    );
    const type = safeProviderErrorIdentifier(
      firstString(record.type, record.error_type, record.errorType, record.status),
    );
    const message = safeErrorText(
      firstString(record.message, record.error_message, record.errorMessage, record.detail),
    );
    const details = sanitizeProviderErrorValue(
      record.details ?? record.error_details ?? record.metadata,
    );
    if (code || type || message || details !== undefined) {
      return { code, type, message, details };
    }
  }
  return undefined;
}

/**
 * Converts only explicit provider-declared model/quota signals into the
 * canonical route-policy codes.  In particular, generic `404`, `410`, and
 * `402` responses remain `provider_api_error` and therefore surface.
 */
export function normalizeProviderErrorCode(
  _provider: string,
  structured: ProviderStructuredError | undefined,
): string | undefined {
  if (!structured) return undefined;
  const code = normalizeProviderSignal(structured.code);
  const type = normalizeProviderSignal(structured.type);
  const detailsText = structured.details === undefined
    ? ""
    : providerErrorValueText(structured.details);
  const identity = [code, type, detailsText].filter(Boolean).join(" ");
  const message = structured.message ?? "";

  if (matchesProviderSignal(identity, [
    "model_retired",
    "model_deprecated",
    "model_decommissioned",
    "model_disabled",
    "model_retired_error",
  ]) || /\bmodel(?:\s+(?:id|name))?\b[^.\n]{0,100}\b(?:retired|deprecated|decommissioned|disabled)\b/iu.test(message)) {
    return "provider_model_retired";
  }
  if (matchesProviderSignal(identity, [
    "unsupported_model",
    "unsupported_model_error",
    "model_not_supported",
    "model_unsupported",
  ]) || /\bmodel(?:\s+(?:id|name))?\b[^.\n]{0,100}\b(?:unsupported|not supported)\b/iu.test(message)) {
    return "provider_unsupported_model";
  }
  if (matchesProviderSignal(identity, [
    "model_unavailable",
    "model_unavailable_error",
  ]) || /\bmodel(?:\s+(?:id|name))?\b[^.\n]{0,100}\b(?:unavailable|not available)\b/iu.test(message)) {
    return "provider_model_unavailable";
  }
  if (matchesProviderSignal(identity, [
    "model_not_found",
    "model_not_found_error",
    "model_missing",
    "unknown_model",
    "invalid_model",
  ]) || (hasModelReference(message) && /\b(?:not found|does not exist|unknown|missing)\b/iu.test(message))) {
    return "provider_model_not_found";
  }
  if (matchesProviderSignal(identity, [
    "insufficient_quota",
    "quota_exceeded",
    "quota_exhausted",
    "quota_depleted",
    "billing_hard_limit_reached",
    "billing_limit_exceeded",
    "credit_exhausted",
    "credits_exhausted",
    "insufficient_credits",
    "payment_required",
    "resource_exhausted",
  ]) || /(?:insufficient|exceeded|exhausted|depleted|hard limit)[^.\n]{0,80}(?:quota|credit|billing|balance)\b/iu.test(message) || /\b(?:quota|credit balance|billing hard limit|payment required)\b/iu.test(message)) {
    return "provider_quota_exhausted";
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function safeProviderErrorIdentifier(value: unknown): string | undefined {
  const text = safeErrorText(value);
  return text ? text.slice(0, 160) : undefined;
}

function sanitizeProviderErrorValue(value: unknown, depth = 0): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return safeErrorText(value);
  if (depth >= 3) return "[truncated]";
  if (Array.isArray(value)) {
    return value
      .slice(0, 24)
      .map((item) => sanitizeProviderErrorValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record).slice(0, 24)) {
    const safeKey = key.replace(/[^a-zA-Z0-9_.:@/-]/gu, "_").slice(0, 120);
    const safeValue = /(?:api[_-]?key|access[_-]?token|token|secret|password|authorization|credential)/iu.test(key)
      ? "[redacted]"
      : sanitizeProviderErrorValue(item, depth + 1);
    if (safeValue !== undefined) result[safeKey] = safeValue;
  }
  return result;
}

function normalizeProviderSignal(value: string | undefined): string {
  return value
    ?.toLocaleLowerCase("en-US")
    .replace(/([a-z])([A-Z])/gu, "$1_$2")
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "") ?? "";
}

function matchesProviderSignal(identity: string, signals: string[]): boolean {
  const tokens = new Set(
    identity
      .split(/\s+/u)
      .map((value) => normalizeProviderSignal(value))
      .filter(Boolean),
  );
  return signals.some((signal) => tokens.has(normalizeProviderSignal(signal)));
}

function providerErrorValueText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function hasModelReference(message: string): boolean {
  return /\bmodels?\/[a-z0-9][a-z0-9._:-]*\b/iu.test(message) ||
    /\bmodel(?:\s+(?:id|name))?\s*(?:is|=|:)?\s*["']?[a-z0-9]+(?:[-_./:][a-z0-9]+)+\b/iu.test(message);
}

function providerRequestId(headers?: Pick<Headers, "get">): string | undefined {
  if (!headers) return undefined;
  for (const name of ["x-request-id", "request-id", "x-zai-request-id"]) {
    const value = safeHeaderValue(headers.get(name));
    if (value) return value;
  }
  return undefined;
}

function providerRateLimit(
  headers?: Pick<Headers, "get">,
): ProviderRateLimitDiagnostic | undefined {
  if (!headers) return undefined;
  const values: ProviderRateLimitDiagnostic = {
    retryAfter: safeHeaderValue(headers.get("retry-after")),
    reset: safeHeaderValue(
      headers.get("ratelimit-reset") ?? headers.get("x-ratelimit-reset"),
    ),
    limit: safeHeaderValue(
      headers.get("ratelimit-limit") ?? headers.get("x-ratelimit-limit"),
    ),
    remaining: safeHeaderValue(
      headers.get("ratelimit-remaining") ?? headers.get("x-ratelimit-remaining"),
    ),
  };
  return Object.values(values).some(Boolean) ? values : undefined;
}

function safeHeaderValue(value: string | null): string | undefined {
  const normalized = value?.split("\r").join(" ").split("\n").join(" ").trim();
  return normalized ? normalized.slice(0, 160) : undefined;
}

function providerRetryAt(headers?: Pick<Headers, "get">): string | undefined {
  if (!headers) return undefined;
  const now = Date.now();
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const timestamp = Number.isFinite(seconds)
      ? now + Math.max(0, seconds) * 1_000
      : Date.parse(retryAfter);
    if (Number.isFinite(timestamp) && timestamp >= now) {
      return new Date(timestamp).toISOString();
    }
  }
  const rateLimitReset = headers.get("ratelimit-reset")?.trim();
  if (rateLimitReset) {
    const seconds = Number(rateLimitReset);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return new Date(now + seconds * 1_000).toISOString();
    }
  }
  const legacyReset = Number(headers.get("x-ratelimit-reset")?.trim());
  if (Number.isFinite(legacyReset) && legacyReset * 1_000 >= now) {
    return new Date(legacyReset * 1_000).toISOString();
  }
  return undefined;
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

export function providerStreamInterruptedError(input: {
  provider: string;
  api: string;
  error: unknown;
  endpoint?: string;
  model?: string;
  admission?: ModelRequestAdmissionReceipt;
  headers?: Pick<Headers, "get">;
}): ModelProviderRequestError {
  const label = providerLabel(input.provider);
  return new ModelProviderRequestError({
    code: "provider_stream_interrupted",
    message: `${label} response stream ended before completion. Butler will apply the configured provider recovery policy.`,
    provider: input.provider,
    api: input.api,
    endpoint: input.endpoint,
    model: input.model,
    retryable: true,
    cause: safeErrorText(errorMessage(input.error)),
    requestGeneration: input.admission?.plan.generation,
    measuredInputTokens: input.admission?.plan.compiled_input_tokens,
    registeredInputCapacity: input.admission?.plan.input_capacity_tokens,
    requestHash: input.admission?.serialized_request_sha256,
    providerRequestId: providerRequestId(input.headers),
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
