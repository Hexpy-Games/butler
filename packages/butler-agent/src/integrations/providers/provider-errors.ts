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
    };
  }
}

export function providerHttpError(input: {
  provider: string;
  api: string;
  statusCode: number;
  detail?: string;
  endpoint?: string;
  model?: string;
}): ModelProviderRequestError {
  const status = input.statusCode;
  const detail = safeErrorText(input.detail);
  const contextLimitExceeded = isContextLimitDetail(detail);
  const code =
    contextLimitExceeded
      ? "provider_context_limit_exceeded"
      : status === 401 || status === 403
      ? "provider_auth_error"
      : status === 429
        ? "provider_rate_limited"
        : "provider_api_error";
  const label = providerLabel(input.provider);
  const message =
    code === "provider_context_limit_exceeded"
      ? `${label} context limit was exceeded. Compact or reduce the session context, then retry.`
      : code === "provider_auth_error"
      ? `${label} authentication failed with HTTP ${status}. Check the configured provider credentials.`
      : code === "provider_rate_limited"
        ? `${label} API rate limit hit with HTTP ${status}. Retry later or switch models.`
        : `${label} API request failed with HTTP ${status}.`;
  return new ModelProviderRequestError({
    code,
    message,
    provider: input.provider,
    api: input.api,
    statusCode: status,
    endpoint: input.endpoint,
    model: input.model,
    retryable: contextLimitExceeded || status === 429 || status >= 500,
    cause: detail,
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
  const label = input.local ? "The selected local model" : providerLabel(input.provider);
  return new ModelProviderRequestError({
    code: "provider_empty_response",
    message: `${label} returned no visible answer. Retry the turn or switch models.`,
    provider: input.provider,
    api: input.api,
    endpoint: input.endpoint,
    model: input.model,
    retryable: true,
  });
}

export function safeRuntimeFailure(error: unknown): RuntimeFailureDiagnostic {
  if (error instanceof ModelProviderRequestError) return error.diagnostic();
  const message = errorMessage(error);
  const status = statusCodeFromMessage(message);
  if (/Local model API returned no (?:visible )?(?:final )?(?:text output|answer envelope)/iu.test(message)) {
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
  if (/(?:OpenAI Responses API error|Codex backend error)/iu.test(message) && status) {
    return providerHttpError({
      provider: /Codex backend error/iu.test(message) ? "openai-codex" : "openai",
      api: /Codex backend error/iu.test(message) ? "codex_responses" : "responses",
      statusCode: status,
      detail: message,
    }).diagnostic();
  }
  if (
    /Unable to connect|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|network|connection termination|disconnect\/reset/iu
      .test(message)
  ) {
    return providerNetworkError({
      provider: "model-provider",
      api: "model-api",
      error: message,
    }).diagnostic();
  }
  if (/goal completion|could not verify that the requested goal was completed/iu.test(message)) {
    return {
      code: "goal_completion_incomplete",
      message: "Butler could not verify that the requested goal was completed.",
      retryable: true,
      cause: safeErrorText(message),
    };
  }
  return {
    code: "gateway_failed",
    message: "Butler could not complete this turn.",
    retryable: true,
    cause: safeErrorText(message),
  };
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
    }).filter(([, value]) => value !== undefined && value !== ""),
  );
}

export function safeEndpointLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.replace(/[?#].*$/u, "");
  }
}

function statusCodeFromMessage(message: string): number | undefined {
  const match = message.match(/\((\d{3})\)|HTTP\s+(\d{3})|status\s+(\d{3})/iu);
  const value = Number(match?.[1] ?? match?.[2] ?? match?.[3]);
  return Number.isFinite(value) ? value : undefined;
}

function providerLabel(provider: string): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "openai-codex") return "OpenAI Codex";
  if (provider === "local") return "Local model";
  return "Model provider";
}

function isContextLimitDetail(detail: string | undefined): boolean {
  if (!detail) return false;
  return /(?:available context size|context (?:size|window|length)|maximum context|too many tokens|request \(\d+ tokens\) exceeds|input tokens? exceed)/iu
    .test(detail);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown runtime error";
}

function safeErrorText(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : "";
  const normalized = text
    .replace(/\b(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/giu, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized ? normalized.slice(0, 500) : undefined;
}
