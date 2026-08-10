import type {
  ProviderQuotaResult,
  ProviderQuotaWindow,
} from "../../../operations/metrics/provider-quota.ts";

export const CODEX_RATE_LIMIT_SOURCE = {
  kind: "codex_app_server",
  id: "openai-codex-rate-limits",
} as const;

export type OpenAICodexRateLimitsParseResult =
  | { kind: "ok"; result: ProviderQuotaResult }
  | { kind: "auth" }
  | { kind: "rpc" }
  | { kind: "malformed" };

interface JsonRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampPercent(value: number | null): number | null {
  return value === null ? null : Math.max(0, Math.min(100, value));
}

function safePlanName(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const sanitized = value.trim().replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 80);
  return sanitized || null;
}

export function mapOpenAICodexRateLimits(
  payload: unknown,
): ProviderQuotaResult | null {
  if (!isRecord(payload)) return null;
  const byId = isRecord(payload.rateLimitsByLimitId)
    ? payload.rateLimitsByLimitId
    : null;
  const preferred = byId && isRecord(byId.codex) ? byId.codex : null;
  const fallback = isRecord(payload.rateLimits) ? payload.rateLimits : null;
  const candidates = [preferred, fallback].filter(
    (candidate, index, all): candidate is JsonRecord =>
      candidate !== null && all.indexOf(candidate) === index,
  );
  const selected = candidates
    .map((limits) => ({
      limits,
      windows: ["primary", "secondary"]
        .map((id) => mapWindow(id, limits[id], false))
        .concat([mapWindow("individualLimit", limits.individualLimit, true)])
        .filter((window): window is ProviderQuotaWindow => window !== null),
    }))
    .find((candidate) => candidate.windows.length > 0);
  if (!selected) return null;
  const { limits, windows } = selected;
  const planName = safePlanName(limits.planType);
  const rawPlan = typeof limits.planType === "string"
    ? limits.planType.toLowerCase()
    : "";
  const planKind = rawPlan.includes("api") || rawPlan.includes("key")
    ? "api"
    : planName
      ? "subscription"
      : "unknown";
  return {
    available: true,
    stale: false,
    sourceKind: CODEX_RATE_LIMIT_SOURCE.kind,
    sourceId: CODEX_RATE_LIMIT_SOURCE.id,
    planKind,
    planName,
    windows,
    fetchedAt: new Date().toISOString(),
    reason: null,
  };
}

function mapWindow(
  id: string,
  value: unknown,
  spendControlOnly: boolean,
): ProviderQuotaWindow | null {
  if (!isRecord(value)) return null;
  const explicitRemaining = clampPercent(numberOrNull(value.remainingPercent));
  const used = clampPercent(numberOrNull(value.usedPercent)) ??
    (explicitRemaining === null ? null : 100 - explicitRemaining);
  const remaining = explicitRemaining ?? (used === null ? null : 100 - used);
  if (used === null && remaining === null) return null;
  return {
    id,
    usedPercent: used,
    remainingPercent: remaining,
    windowDurationMins: spendControlOnly
      ? null
      : Math.max(0, numberOrNull(value.windowDurationMins) ?? 0) || null,
    resetsAt: timestampOrNull(value.resetsAt),
    expiresAt: spendControlOnly ? null : timestampOrNull(value.expiresAt),
  };
}

function timestampOrNull(value: unknown): string | null {
  const raw = typeof value === "number" && Number.isFinite(value)
    ? new Date(value < 1_000_000_000_000 ? value * 1000 : value)
    : typeof value === "string" && value.trim() && value.length <= 64
      ? new Date(value.trim())
      : null;
  if (raw && Number.isFinite(raw.getTime())) return raw.toISOString();
  return null;
}

function parseJsonLines(stdout: string): JsonRecord[] {
  const messages: JsonRecord[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) messages.push(parsed);
    } catch {
      // The provider protocol is JSONL; malformed lines remain sanitized.
    }
  }
  return messages;
}

export function parseOpenAICodexRateLimits(
  stdout: string,
): OpenAICodexRateLimitsParseResult {
  const messages = parseJsonLines(stdout);
  const response = messages.find((message) => message.id === 2);
  if (!response) {
    const initializeResponse = messages.find((message) => message.id === 1);
    if (initializeResponse && isRecord(initializeResponse.error)) {
      return isAuthRpcError(initializeResponse.error)
        ? { kind: "auth" }
        : { kind: "rpc" };
    }
    return { kind: "malformed" };
  }
  if (isRecord(response.error)) {
    return isAuthRpcError(response.error) ? { kind: "auth" } : { kind: "rpc" };
  }
  const result = mapOpenAICodexRateLimits(response.result);
  return result ? { kind: "ok", result } : { kind: "malformed" };
}

function isAuthRpcError(error: JsonRecord): boolean {
  const code = error.code;
  const message = typeof error.message === "string"
    ? error.message.toLowerCase()
    : "";
  const data = isRecord(error.data)
    ? [dataString(error.data.code), dataString(error.data.type), dataString(error.data.reason)]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
    : "";
  return code === 401 || code === 403 || code === "unauthorized" ||
    message.includes("unauthor") || message.includes("not logged") ||
    message.includes("login") || message.includes("auth") ||
    data.includes("not_logged") || data.includes("unauthor") || data.includes("auth");
}

function dataString(value: unknown): string {
  return typeof value === "string" && value.length <= 80 ? value : "";
}
