import type {
  ProviderQuotaResult,
  ProviderQuotaWindow,
} from "../../../operations/metrics/provider-quota.ts";

export const ZAI_QUOTA_SOURCE = {
  kind: "zai_usage_query",
  id: "zai-coding-plan-usage-query",
} as const;

export type ZaiQuotaResponseParseResult =
  | { kind: "ok"; result: ProviderQuotaResult }
  | { kind: "unsupported" }
  | { kind: "malformed" };

interface JsonRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safePlanName(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const sanitized = value.trim().replace(/[^A-Za-z0-9 _-]/gu, "").slice(0, 80);
  return sanitized || null;
}

function clampPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function safeResetTimestamp(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 1e12 || value > 8.64e15) return null;
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

function mapLimitWindow(
  id: string,
  value: JsonRecord,
  windowDurationMins: number | null,
): ProviderQuotaWindow | null {
  const usedPercent = clampPercent(value.percentage);
  if (usedPercent === null) return null;
  return {
    id,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    windowDurationMins,
    resetsAt: safeResetTimestamp(value.nextResetTime),
    expiresAt: null,
  };
}

export function parseZaiQuotaResponse(payload: unknown): ZaiQuotaResponseParseResult {
  if (!isRecord(payload) ||
    (payload.success !== undefined && payload.success !== true) ||
    !isRecord(payload.data)) {
    return { kind: "malformed" };
  }
  const rawLimits = payload.data.limits;
  if (!Array.isArray(rawLimits)) return { kind: "malformed" };
  const limits = rawLimits.filter(isRecord);
  if (limits.length !== rawLimits.length) return { kind: "malformed" };
  const planName = safePlanName(payload.data.level);
  if (planName && !["lite", "pro", "max"].includes(planName.toLowerCase())) {
    return { kind: "unsupported" };
  }

  let fiveHourCount = 0;
  let weeklyCount = 0;
  const tokenWindows = limits
    .filter((limit) => limit.type === "TOKENS_LIMIT")
    .flatMap((limit) => {
      const unit = limit.unit;
      const number = limit.number;
      if (unit === 3 && number === 5) {
        fiveHourCount += 1;
        const id = fiveHourCount === 1
          ? "tokens-5-hour"
          : `tokens-5-hour-${fiveHourCount}`;
        const window = mapLimitWindow(id, limit, 300);
        return window ? [window] : [];
      }
      if (unit === 6 && number === 1) {
        weeklyCount += 1;
        const id = weeklyCount === 1
          ? "tokens-weekly"
          : `tokens-weekly-${weeklyCount}`;
        const window = mapLimitWindow(id, limit, 10080);
        return window ? [window] : [];
      }
      return [];
    });
  if (tokenWindows.length === 0) return { kind: "malformed" };

  const mcpLimit = limits.find((limit) =>
    limit.type === "TIME_LIMIT" && limit.unit === 5 && limit.number === 1,
  );
  const mcpWindow = mcpLimit
    ? mapLimitWindow("mcp-month", mcpLimit, null)
    : null;
  const windows = mcpWindow ? [...tokenWindows, mcpWindow] : tokenWindows;
  return { kind: "ok", result: {
    available: true,
    stale: false,
    sourceKind: ZAI_QUOTA_SOURCE.kind,
    sourceId: ZAI_QUOTA_SOURCE.id,
    planKind: "subscription",
    planName,
    windows,
    fetchedAt: new Date().toISOString(),
    reason: null,
  } };
}

export function mapZaiQuotaResponse(payload: unknown): ProviderQuotaResult | null {
  const parsed = parseZaiQuotaResponse(payload);
  return parsed.kind === "ok" ? parsed.result : null;
}
