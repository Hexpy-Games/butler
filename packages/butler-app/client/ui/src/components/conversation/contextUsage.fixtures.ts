import type { ContextDetailsView, ProviderQuotaResultView, UsageMonitorView } from "../../app/types.ts";

export const usageContext: ContextDetailsView = {
  session_id: "s1", provider_id: "openai", model_ref: "openai/m",
  used_tokens: 18_000, budget_tokens: 258_000, ratio: 0.07, categories: [],
};

export function quota(fields: Partial<ProviderQuotaResultView> = {}): ProviderQuotaResultView {
  return {
    available: true, stale: false, sourceKind: "chatgpt_plan", sourceId: "openai-chatgpt-plan", planKind: "subscription",
    estimated: true, planUsage: { state: "in_use", resetsAt: null },
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
    filters: { sessionId: "s1", sinceTs: null, untilTs: null },
    timeline: { slotMinutes: 15, slots: [[Date.parse("2026-09-28T05:00:00Z"), 3, 48_200, 31_900, 3_420]] },
    topSessions: [], previousPeriod: null,
    model: { ...bucket, cacheHitRatio: 0.66, byScope: {}, byScopeUsage: {}, byModel: {}, bySection: {} },
    webSearch: { requestCount: 0, lastProvider: null, lastError: null },
    tools: { calls: 0, results: 0, successes: 0, failures: 0, byTool: {} },
    providerUsage: {
      activeProviderId: "openai",
      providers: [{ ...bucket, providerId: "openai", source: "local_telemetry", remaining: fields.quota ?? quota({ available: false, windows: [] }),
        butlerUsage: { account: "chatgpt_plan", asOf: "2026-09-28T05:10:00Z", windows: [
          { id: "hours_5", requests: 3, inputTokens: 48200, outputTokens: 3420, totalTokens: 51620 },
          { id: "days_7", requests: 8, inputTokens: 80000, outputTokens: 10000, totalTokens: 90000 },
          { id: "days_30", requests: 30, inputTokens: 300000, outputTokens: 40000, totalTokens: 340000 },
        ] },
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

/** A chat whose delegated work ran 8 more calls: totals include it, byRole and subtasks split it. */
export function delegatedUsageView(fields: Parameters<typeof usageView>[0] = {}): UsageMonitorView {
  const view = usageView(fields);
  const role = (requestCount: number, promptTokens: number, cachedTokens: number, outputTokens: number) => ({
    requestCount, promptTokens, cachedTokens, uncachedTokens: promptTokens - cachedTokens, outputTokens,
    totalTokens: promptTokens + outputTokens, missingTotalTokenCount: 0 });
  const main = role(3, 48_200, 31_900, 3_420);
  const steward = role(2, 9_800, 6_100, 900);
  const worker = role(6, 31_400, 22_000, 2_600);
  const subtasks = role(8, 41_200, 28_100, 3_500);
  const total = role(11, 89_400, 60_000, 6_920);
  view.model = { ...view.model, ...total, cacheHitRatio: 0.67, byRole: { main, steward, worker }, subtasks };
  // The slot appends the delegated total, then that work's requests, cached and output.
  view.timeline.slots = [[Date.parse("2026-09-28T05:00:00Z"), 11, 89_400, 60_000, 6_920, 44_700, 8, 28_100, 3_500]];
  return view;
}

export const chatGptUsageFixtures = {
  headers: quota(),
  noHeaders: quota({ windows: [] }),
  limit: quota({ planUsage: { state: "limit_reached", resetsAt: "2026-09-28T09:00:00Z" } }),
};
