export interface UsageTokenBucket { requestCount: number; promptTokens: number; cachedTokens: number; totalTokens: number }
export interface ProviderQuotaWindow { id: string; remainingPercent: number | null; windowDurationMins: number | null; resetsAt: string | null }
export interface ProviderQuotaResult {
  available: boolean; stale: boolean;
  sourceKind: "chatgpt_plan" | "zai_usage_query" | "provider_quota";
  planUsage?: { state: "in_use" | "limit_reached"; resetsAt: string | null } | null;
  windows: ProviderQuotaWindow[]; fetchedAt: string | null;
}
export interface ButlerUsage { windows: { id: "hours_5" | "days_7" | "days_30"; totalTokens: number }[] }
export interface UsageMonitorView {
  /** Each slot: [startMs, requests, prompt, cached, output, (session views:) delegated, dRequests, dCached, dOutput]. */
  timeline: { slotMinutes: 15; slots: number[][] };
  filters: { sessionId: string | null; sinceTs: number | null; untilTs: number | null };
  model: UsageTokenBucket & { subtasks?: UsageTokenBucket };
  providerUsage: { activeProviderId: string | null; providers: { providerId: string; remaining: ProviderQuotaResult; butlerUsage?: ButlerUsage | null }[] };
  cost: { available: boolean; estimatedUsd: number | null };
  generated_at: string;
}
