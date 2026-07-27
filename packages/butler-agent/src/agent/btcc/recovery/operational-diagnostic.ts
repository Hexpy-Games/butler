export type ProviderCarrierRejectionReason =
  | "missing_required"
  | "unexpected_property"
  | "constant_mismatch"
  | "enum_mismatch"
  | "variant_mismatch"
  | "type_mismatch"
  | "minimum_items"
  | "maximum_items"
  | "minimum_value"
  | "maximum_value"
  | "minimum_length"
  | "maximum_length"
  | "carrier_not_object"
  | "closed_protocol_mismatch"
  | "operation_authority_mismatch";

export type ProviderCarrierShape = {
  carrierType: JsonValueType;
  carrierKeys: string[];
  submissionType?: JsonValueType;
  submissionKeys: string[];
  requestsType?: JsonValueType;
  requestCount?: number;
  requestKeys: string[][];
};

type JsonValueType =
  | "array"
  | "boolean"
  | "null"
  | "number"
  | "object"
  | "string"
  | "undefined";

export type OperationalDiagnostic =
  | ProviderRequestDiagnostic
  | ProviderCarrierRejectionDiagnostic;

type ProviderRequestDiagnostic = {
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

export type ProviderCarrierRejectionDiagnostic = {
  schema: "btcc.operational-diagnostic.v1";
  kind: "provider_carrier_rejection";
  path: string;
  reason: ProviderCarrierRejectionReason;
  shape: ProviderCarrierShape;
};

const IDENTIFIER_LIMIT = 96;
const MODEL_LIMIT = 160;
const ENDPOINT_LIMIT = 320;
const REQUEST_ID_LIMIT = 160;
const SCHEMA_PATH_LIMIT = 320;
const SHAPE_KEY_LIMIT = 64;
const SHAPE_KEYS_LIMIT = 48;
const SHAPE_REQUESTS_LIMIT = 16;

const CARRIER_REJECTION_REASONS: readonly ProviderCarrierRejectionReason[] = [
  "missing_required",
  "unexpected_property",
  "constant_mismatch",
  "enum_mismatch",
  "variant_mismatch",
  "type_mismatch",
  "minimum_items",
  "maximum_items",
  "minimum_value",
  "maximum_value",
  "minimum_length",
  "maximum_length",
  "carrier_not_object",
  "closed_protocol_mismatch",
  "operation_authority_mismatch",
];

export function decodeOperationalDiagnostic(
  input: unknown,
): OperationalDiagnostic | undefined {
  const value = decodeJson(input);
  if (!isRecord(value) || value.schema !== "btcc.operational-diagnostic.v1") {
    return undefined;
  }
  if (value.kind === "provider_request") return decodeProviderRequest(value);
  if (value.kind === "provider_carrier_rejection") {
    return decodeProviderCarrierRejection(value);
  }
  return undefined;
}

function decodeProviderRequest(
  value: Record<string, unknown>,
): ProviderRequestDiagnostic | undefined {
  if (typeof value.retryable !== "boolean") return undefined;
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

function decodeProviderCarrierRejection(
  value: Record<string, unknown>,
): ProviderCarrierRejectionDiagnostic | undefined {
  const path = safeSchemaPath(value.path);
  const reason = carrierRejectionReason(value.reason);
  const shape = safeCarrierShape(value.shape);
  if (!path || !reason || !shape) return undefined;
  return {
    schema: "btcc.operational-diagnostic.v1",
    kind: "provider_carrier_rejection",
    path,
    reason,
    shape,
  };
}

function safeCarrierShape(value: unknown): ProviderCarrierShape | undefined {
  if (!isRecord(value)) return undefined;
  const carrierType = jsonValueType(value.carrierType);
  const carrierKeys = safeShapeKeys(value.carrierKeys);
  const submissionType = optionalJsonValueType(value.submissionType);
  const submissionKeys = safeShapeKeys(value.submissionKeys);
  const requestsType = optionalJsonValueType(value.requestsType);
  const requestCount = safeInteger(value.requestCount, 0, 100_000);
  const requestKeys = safeRequestKeys(value.requestKeys);
  if (!carrierType || !carrierKeys || !submissionKeys || !requestKeys) return undefined;
  return {
    carrierType,
    carrierKeys,
    ...(submissionType ? { submissionType } : {}),
    submissionKeys,
    ...(requestsType ? { requestsType } : {}),
    ...(requestCount === undefined ? {} : { requestCount }),
    requestKeys,
  };
}

function safeShapeKeys(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > SHAPE_KEYS_LIMIT) return undefined;
  return value.map((entry) => safeShapeKey(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function safeRequestKeys(value: unknown): string[][] | undefined {
  if (!Array.isArray(value) || value.length > SHAPE_REQUESTS_LIMIT) return undefined;
  const requests = value.map((entry) => safeShapeKeys(entry));
  return requests.every((entry): entry is string[] => Boolean(entry))
    ? requests
    : undefined;
}

function safeShapeKey(value: unknown): string | undefined {
  return safeIdentifier(value, SHAPE_KEY_LIMIT);
}

function safeSchemaPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > SCHEMA_PATH_LIMIT) return undefined;
  for (const character of value) {
    if (!isSafeSchemaPathCharacter(character)) return undefined;
  }
  return value;
}

function isSafeSchemaPathCharacter(value: string): boolean {
  return isSafeIdentifierCharacter(value) ||
    value === "$" || value === "[" || value === "]";
}

function carrierRejectionReason(value: unknown): ProviderCarrierRejectionReason | undefined {
  return typeof value === "string" &&
      CARRIER_REJECTION_REASONS.includes(value as ProviderCarrierRejectionReason)
    ? value as ProviderCarrierRejectionReason
    : undefined;
}

function optionalJsonValueType(value: unknown): JsonValueType | undefined {
  return value === undefined ? undefined : jsonValueType(value);
}

function jsonValueType(value: unknown): JsonValueType | undefined {
  return value === "array" || value === "boolean" || value === "null" ||
      value === "number" || value === "object" || value === "string" ||
      value === "undefined"
    ? value
    : undefined;
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
  return code >= 48 && code <= 57 || code >= 65 && code <= 90 ||
    code >= 97 && code <= 122 || value === "-" || value === "_" ||
    value === "." || value === ":" || value === "/";
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
    if (!(code >= 48 && code <= 57 || code >= 97 && code <= 102)) return undefined;
  }
  return value;
}

function safeRateLimit(value: unknown): ProviderRequestDiagnostic["rateLimit"] {
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
  return safeNonnegativeNumber(value) ?? safeTimestamp(value);
}

function safeNonnegativeNumber(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? String(number) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
