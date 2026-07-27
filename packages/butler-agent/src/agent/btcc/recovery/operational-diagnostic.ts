export type OperationalDiagnostic = {
  schema: "btcc.operational-diagnostic.v1";
  kind: "provider_request";
  provider: string;
  api: string;
  statusCode?: number;
  endpoint?: string;
  model?: string;
  retryable: boolean;
  retryAt?: string;
  providerRequestId?: string;
  requestGeneration?: number;
  measuredInputTokens?: number;
  registeredInputCapacity?: number;
  requestHash?: string;
  rateLimit?: {
    retryAfter?: string;
    reset?: string;
    limit?: string;
    remaining?: string;
  };
};

const IDENTIFIER_LIMIT = 96;
const MODEL_LIMIT = 160;
const ENDPOINT_LIMIT = 320;
const REQUEST_ID_LIMIT = 160;

export function decodeOperationalDiagnostic(
  input: unknown,
): OperationalDiagnostic | undefined {
  const value = decodeJson(input);
  if (!isRecord(value) ||
    value.schema !== "btcc.operational-diagnostic.v1" ||
    value.kind !== "provider_request" ||
    typeof value.retryable !== "boolean") return undefined;
  const provider = safeIdentifier(value.provider, IDENTIFIER_LIMIT);
  const api = safeIdentifier(value.api, IDENTIFIER_LIMIT);
  if (!provider || !api) return undefined;
  const statusCode = safeInteger(value.statusCode, 100, 599);
  const endpoint = safeEndpoint(value.endpoint);
  const model = safeIdentifier(value.model, MODEL_LIMIT);
  const retryAt = safeTimestamp(value.retryAt);
  const providerRequestId = safeIdentifier(value.providerRequestId, REQUEST_ID_LIMIT);
  const requestGeneration = safeInteger(value.requestGeneration, 0);
  const measuredInputTokens = safeInteger(value.measuredInputTokens, 0);
  const registeredInputCapacity = safeInteger(value.registeredInputCapacity, 0);
  const requestHash = safeSha256(value.requestHash);
  const rateLimit = safeRateLimit(value.rateLimit);
  return {
    schema: "btcc.operational-diagnostic.v1",
    kind: "provider_request",
    provider,
    api,
    retryable: value.retryable,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(endpoint ? { endpoint } : {}),
    ...(model ? { model } : {}),
    ...(retryAt ? { retryAt } : {}),
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(requestGeneration === undefined ? {} : { requestGeneration }),
    ...(measuredInputTokens === undefined ? {} : { measuredInputTokens }),
    ...(registeredInputCapacity === undefined ? {} : { registeredInputCapacity }),
    ...(requestHash ? { requestHash } : {}),
    ...(rateLimit ? { rateLimit } : {}),
  };
}

function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function safeEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > ENDPOINT_LIMIT) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    return `${parsed.origin}${parsed.pathname}`.slice(0, ENDPOINT_LIMIT);
  } catch {
    return undefined;
  }
}

function safeIdentifier(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > limit) return undefined;
  for (const character of normalized) {
    if (!isSafeIdentifierCharacter(character)) return undefined;
  }
  return normalized;
}

function isSafeIdentifierCharacter(value: string): boolean {
  const code = value.charCodeAt(0);
  return code >= 48 && code <= 57 ||
    code >= 65 && code <= 90 ||
    code >= 97 && code <= 122 ||
    value === "-" || value === "_" || value === "." ||
    value === ":" || value === "/";
}

function safeInteger(
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) &&
      value >= minimum && value <= maximum
    ? value
    : undefined;
}

function safeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function safeSha256(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length !== 64) return undefined;
  for (const character of value) {
    const code = character.charCodeAt(0);
    const hexadecimal = code >= 48 && code <= 57 || code >= 97 && code <= 102;
    if (!hexadecimal) return undefined;
  }
  return value;
}

function safeRateLimit(value: unknown): OperationalDiagnostic["rateLimit"] {
  if (!isRecord(value)) return undefined;
  const retryAfter = safeReadinessValue(value.retryAfter);
  const reset = safeReadinessValue(value.reset);
  const limit = safeNonnegativeNumber(value.limit);
  const remaining = safeNonnegativeNumber(value.remaining);
  if (!retryAfter && !reset && !limit && !remaining) return undefined;
  return {
    ...(retryAfter ? { retryAfter } : {}),
    ...(reset ? { reset } : {}),
    ...(limit ? { limit } : {}),
    ...(remaining ? { remaining } : {}),
  };
}

function safeReadinessValue(value: unknown): string | undefined {
  const numeric = safeNonnegativeNumber(value);
  if (numeric) return numeric;
  return safeTimestamp(value);
}

function safeNonnegativeNumber(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? String(number) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
