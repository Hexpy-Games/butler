import type { ContextDetailsView, ProviderQuotaResultView, UsageMonitorView } from "@/app/types.ts";

export const usageContext: ContextDetailsView = {
  session_id: "s1", provider_id: "openai", model_ref: "openai/m",
  used_tokens: 18_000, budget_tokens: 258_000, ratio: 0.07, categories: [],
};

export function quota(fields: Partial<ProviderQuotaResultView> = {}): ProviderQuotaResultView {
  return {
    available: true, stale: false, sourceKind: "codex_app_server", sourceId: "codex", planKind: "subscription",
    planName: null, fetchedAt: "2026-09-28T05:05:00.000Z", reason: null,
    windows: [
      { id: "tokens-5-hour", usedPercent: 18, remainingPercent: 82, windowDurationMins: 300, resetsAt: "2026-09-28T09:00:00.000Z", expiresAt: null },
      { id: "tokens-weekly", usedPercent: 36, remainingPercent: 64, windowDurationMins: 10_080, resetsAt: null, expiresAt: null },
    ],
    ...fields,
  };
}

export function usageView(fields: { quota?: ProviderQuotaResultView; reasoning?: number; usd?: number | null; asOf?: string | null } = {}): UsageMonitorView {
  const bucket = { requestCount: 3, promptTokens: 48_200, cachedTokens: 31_900, uncachedTokens: 16_300, outputTokens: 3_420,
    totalTokens: 51_620, missingTotalTokenCount: 0, ...(fields.reasoning === undefined ? {} : { reasoningTokens: fields.reasoning }) };
  return {
    filters: { sessionId: "s1", sinceTs: null },
    model: { ...bucket, cacheHitRatio: 0.66, byScope: {}, byScopeUsage: {}, byModel: {}, bySection: {} },
    webSearch: { requestCount: 0, lastProvider: null, lastError: null },
    tools: { calls: 0, results: 0, successes: 0, failures: 0, byTool: {} },
    providerUsage: {
      activeProviderId: "openai",
      providers: [{ ...bucket, providerId: "openai", source: "local_telemetry", remaining: fields.quota ?? quota({ available: false, windows: [] }),
        billing: { available: false, reason: "n/a" } }],
    },
    cost: fields.usd === undefined || fields.usd === null
      ? { available: false, estimatedUsd: null, reason: "unpriced" }
      : { available: true, estimatedUsd: fields.usd, reason: "", asOf: fields.asOf ?? null },
    privacy: { rawTextStored: false, rawToolArgumentsIncluded: false, rawToolResultsIncluded: false },
    generated_at: "2026-09-28T05:10:00.000Z",
    raw_text_included: false,
  };
}
