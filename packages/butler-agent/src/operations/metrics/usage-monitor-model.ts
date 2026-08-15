import {
  unavailableProviderQuota,
} from "./provider-quota.ts";
import type { PromptCacheMetricEvent } from "../../integrations/providers/prompt-cache-metrics.ts";
import type {
  UsageModelSummary,
  UsageProviderSummary,
  UsageProviderView,
  UsageTokenBucket,
} from "./usage-monitor.ts";

const MAX_USAGE_KEYS = 512;

function emptyTokenBucket(): UsageTokenBucket {
  return {
    requestCount: 0,
    promptTokens: 0,
    cachedTokens: 0,
    uncachedTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    missingTotalTokenCount: 0,
  };
}

function tokenBucketFor(
  buckets: Record<string, UsageTokenBucket>,
  key: string,
): UsageTokenBucket {
  buckets[key] ??= emptyTokenBucket();
  return buckets[key];
}

function addPromptMetric(bucket: UsageTokenBucket, event: PromptCacheMetricEvent): void {
  const totalTokens = typeof event.totalTokens === "number" && Number.isFinite(event.totalTokens)
    ? event.totalTokens
    : null;
  bucket.requestCount += 1;
  bucket.promptTokens += event.promptTokens;
  bucket.cachedTokens += event.cachedTokens;
  bucket.uncachedTokens += Math.max(0, event.promptTokens - event.cachedTokens);
  bucket.totalTokens += totalTokens ?? 0;
  bucket.outputTokens += totalTokens === null ? 0 : Math.max(0, totalTokens - event.promptTokens);
  if (totalTokens === null) bucket.missingTotalTokenCount += 1;
}

function safeAttributionKey(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function boundedKey<T>(record: Record<string, T>, key: string): string {
  if (Object.prototype.hasOwnProperty.call(record, key)) return key;
  if (Object.keys(record).length >= MAX_USAGE_KEYS) return "__other__";
  return key;
}

export function createModelUsageSummary(): UsageModelSummary {
  return {
    ...emptyTokenBucket(),
    cacheHitRatio: 0,
    byScope: {},
    byScopeUsage: {},
    byModel: {},
    byTurn: {},
    byPhase: {},
    byTurnPhase: {},
    bySection: {},
    budgetStates: {},
    promptCache: { missingKeyCount: 0, missingRetentionCount: 0 },
  };
}

export function addModelUsageEvent(summary: UsageModelSummary, event: PromptCacheMetricEvent): void {
  addPromptMetric(summary, event);
  const scope = boundedKey(summary.byScope, event.scope);
  summary.byScope[scope] = (summary.byScope[scope] || 0) + 1;
  addPromptMetric(tokenBucketFor(summary.byScopeUsage, scope), event);
  const model = boundedKey(summary.byModel, event.model);
  addPromptMetric(tokenBucketFor(summary.byModel, model), event);
  const turnId = boundedKey(summary.byTurn, safeAttributionKey(event.turnId, "unknown-turn"));
  const phase = boundedKey(summary.byPhase, safeAttributionKey(event.phase, event.scope));
  const turnPhase = boundedKey(summary.byTurnPhase, `${turnId}:${phase}`);
  addPromptMetric(tokenBucketFor(summary.byTurn, turnId), event);
  addPromptMetric(tokenBucketFor(summary.byPhase, phase), event);
  addPromptMetric(tokenBucketFor(summary.byTurnPhase, turnPhase), event);
  if (!event.promptCacheKey) summary.promptCache.missingKeyCount += 1;
  if (!event.promptCacheRetention) summary.promptCache.missingRetentionCount += 1;
  if (event.budgetState) {
    const budgetStateKey = boundedKey(
      summary.budgetStates,
      safeAttributionKey(event.turnId, "unknown-turn"),
    );
    summary.budgetStates[budgetStateKey] = event.budgetState;
  }
  for (const section of event.promptSections ?? []) {
    if (!section.id.trim()) continue;
    const sectionId = boundedKey(summary.bySection, section.id);
    const bucket = summary.bySection[sectionId] ?? { requestCount: 0, chars: 0, estimatedTokens: 0 };
    bucket.requestCount += 1;
    bucket.chars += Number.isFinite(section.chars) ? Math.max(0, section.chars) : 0;
    bucket.estimatedTokens += Number.isFinite(section.estimatedTokens)
      ? Math.max(0, section.estimatedTokens)
      : 0;
    summary.bySection[sectionId] = bucket;
  }
}

export function finalizeModelUsage(summary: UsageModelSummary): UsageModelSummary {
  if (summary.promptTokens > 0) summary.cacheHitRatio = summary.cachedTokens / summary.promptTokens;
  return summary;
}

export function emptyUsageTokenBucket(): UsageTokenBucket {
  return emptyTokenBucket();
}

export function providerIdFromModel(model: string): string {
  const trimmed = model.trim();
  const slashIndex = trimmed.indexOf("/");
  return slashIndex > 0 ? trimmed.slice(0, slashIndex) : "custom";
}

export function addProviderUsageEvent(
  buckets: Map<string, UsageTokenBucket>,
  event: PromptCacheMetricEvent,
): void {
  const providerId = providerIdFromModel(event.model);
  const providerKey = buckets.has(providerId) || buckets.size < 64 ? providerId : "__other__";
  const bucket = buckets.get(providerKey) ?? emptyTokenBucket();
  addPromptMetric(bucket, event);
  buckets.set(providerKey, bucket);
}

export function summarizeProviderUsageBuckets(
  buckets: Map<string, UsageTokenBucket>,
): UsageProviderSummary {
  const providers = [...buckets.entries()]
    .map(([providerId, bucket]) => ({
      ...bucket,
      providerId,
      source: "local_telemetry" as const,
      remaining: unavailableProviderQuota({
        code: "provider_quota_surface_unavailable",
        message: "Provider quota adapter is not configured.",
      }, { kind: "provider_quota", id: `${providerId}-unconfigured` }),
      billing: { available: false, reason: "Provider billing adapter is not configured." },
    } satisfies UsageProviderView))
    .sort((left, right) => right.totalTokens - left.totalTokens ||
      right.promptTokens - left.promptTokens || left.providerId.localeCompare(right.providerId));
  return {
    activeProviderId: providers[0]?.providerId ?? null,
    providers,
  };
}
