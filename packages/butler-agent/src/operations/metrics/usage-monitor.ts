import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  readWebSearchMetricEvents,
  readWebSearchMetrics,
} from "../../integrations/search/provider.ts";
import {
  readPromptCacheMetrics,
  type PromptCacheMetricEvent,
} from "../../integrations/providers/prompt-cache-metrics.ts";

export interface ToolUsageBucket {
  calls: number;
  results: number;
  successes: number;
  failures: number;
}

export interface UsageTokenBucket {
  requestCount: number;
  promptTokens: number;
  cachedTokens: number;
  uncachedTokens: number;
  outputTokens: number;
  totalTokens: number;
  missingTotalTokenCount: number;
}

export interface UsageModelSummary extends UsageTokenBucket {
  cacheHitRatio: number;
  byScope: Record<string, number>;
  byScopeUsage: Record<string, UsageTokenBucket>;
  byModel: Record<string, UsageTokenBucket>;
  byTurn: Record<string, UsageTokenBucket>;
  byPhase: Record<string, UsageTokenBucket>;
  byTurnPhase: Record<string, UsageTokenBucket>;
  bySection: Record<string, {
    requestCount: number;
    chars: number;
    estimatedTokens: number;
  }>;
  budgetStates: Record<string, {
    status: "ok" | "warning" | "exhausted";
    requestCount: number;
    maxRequests: number;
    promptTokens?: number;
    cachedTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    maxPromptTokens?: number;
    maxOutputTokens?: number;
    maxTotalTokens?: number;
    stopReason?: string;
  }>;
  promptCache: {
    missingKeyCount: number;
    missingRetentionCount: number;
  };
}

export interface UsageMonitorSummary {
  filters: {
    sessionId: string | null;
    sinceTs: number | null;
  };
  model: UsageModelSummary;
  webSearch: {
    requestCount: number;
    lastProvider: string | null;
    lastError: string | null;
  };
  tools: ToolUsageBucket & {
    byTool: Record<string, ToolUsageBucket>;
  };
  providerUsage: UsageProviderSummary;
  cost: {
    available: false;
    estimatedUsd: null;
    reason: string;
  };
  privacy: {
    rawTextStored: false;
    rawToolArgumentsIncluded: false;
    rawToolResultsIncluded: false;
  };
}

export interface UsageProviderView extends UsageTokenBucket {
  providerId: string;
  source: "local_telemetry" | "provider_adapter";
  remaining: {
    available: boolean;
    reason: string;
  };
  billing: {
    available: boolean;
    reason: string;
  };
}

export interface UsageProviderSummary {
  activeProviderId: string | null;
  providers: UsageProviderView[];
}

interface UsageProviderAdapter {
  providerId: string;
  summarize(events: PromptCacheMetricEvent[]): UsageProviderView | null;
}

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
}

function transcriptPaths(input: {
  butlerData: string;
  sessionId?: string;
}): string[] {
  const dir = join(input.butlerData, "transcripts");
  if (input.sessionId?.trim()) {
    return [join(dir, `${safeSessionId(input.sessionId.trim())}.jsonl`)];
  }
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".jsonl"))
    .map((entry) => join(dir, entry));
}

function emptyBucket(): ToolUsageBucket {
  return {
    calls: 0,
    results: 0,
    successes: 0,
    failures: 0,
  };
}

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

function bucketFor(byTool: Record<string, ToolUsageBucket>, name: string): ToolUsageBucket {
  byTool[name] ??= emptyBucket();
  return byTool[name];
}

function eventInWindow(timestamp: unknown, sinceTs: number | null): boolean {
  if (sinceTs === null) return true;
  if (typeof timestamp !== "string") return false;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && parsed >= sinceTs;
}

function summarizeToolUsage(input: {
  butlerData: string;
  sessionId?: string;
  sinceTs: number | null;
}): UsageMonitorSummary["tools"] {
  const summary: UsageMonitorSummary["tools"] = {
    ...emptyBucket(),
    byTool: {},
  };
  for (const path of transcriptPaths(input)) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as {
          kind?: unknown;
          timestamp?: unknown;
          payload?: {
            name?: unknown;
            ok?: unknown;
          };
        };
        if (!eventInWindow(event.timestamp, input.sinceTs)) continue;
        const name = typeof event.payload?.name === "string" && event.payload.name.trim()
          ? event.payload.name.trim()
          : null;
        if (!name) continue;
        const bucket = bucketFor(summary.byTool, name);
        if (event.kind === "tool_call") {
          summary.calls += 1;
          bucket.calls += 1;
        } else if (event.kind === "tool_result") {
          summary.results += 1;
          bucket.results += 1;
          if (event.payload?.ok === false) {
            summary.failures += 1;
            bucket.failures += 1;
          } else {
            summary.successes += 1;
            bucket.successes += 1;
          }
        }
      } catch {
        continue;
      }
    }
  }
  return summary;
}

function summarizeWebSearchUsage(input: {
  butlerData: string;
  sinceTs: number | null;
}): UsageMonitorSummary["webSearch"] {
  if (input.sinceTs === null) {
    const webSearch = readWebSearchMetrics(input.butlerData);
    return {
      requestCount: webSearch.requestCount,
      lastProvider: webSearch.lastProvider,
      lastError: webSearch.lastError,
    };
  }

  const events = readWebSearchMetricEvents({
    butlerData: input.butlerData,
    sinceTs: input.sinceTs,
  }).sort((left, right) => left.ts - right.ts);
  const latest = events.at(-1);
  return {
    requestCount: events.length,
    lastProvider: latest?.provider ?? null,
    lastError: latest?.error ?? null,
  };
}

function addPromptMetric(
  bucket: UsageTokenBucket,
  event: PromptCacheMetricEvent,
): void {
  const totalTokens =
    typeof event.totalTokens === "number" && Number.isFinite(event.totalTokens)
      ? event.totalTokens
      : null;
  bucket.requestCount += 1;
  bucket.promptTokens += event.promptTokens;
  bucket.cachedTokens += event.cachedTokens;
  bucket.uncachedTokens += Math.max(0, event.promptTokens - event.cachedTokens);
  bucket.totalTokens += totalTokens ?? 0;
  bucket.outputTokens += totalTokens === null
    ? 0
    : Math.max(0, totalTokens - event.promptTokens);
  if (totalTokens === null) bucket.missingTotalTokenCount += 1;
}

function safeAttributionKey(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function summarizeModelUsage(events: PromptCacheMetricEvent[]): UsageModelSummary {
  const summary: UsageModelSummary = {
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
    promptCache: {
      missingKeyCount: 0,
      missingRetentionCount: 0,
    },
  };

  for (const event of events) {
    addPromptMetric(summary, event);
    summary.byScope[event.scope] = (summary.byScope[event.scope] || 0) + 1;
    addPromptMetric(tokenBucketFor(summary.byScopeUsage, event.scope), event);
    addPromptMetric(tokenBucketFor(summary.byModel, event.model), event);
    const turnId = safeAttributionKey(event.turnId, "unknown-turn");
    const phase = safeAttributionKey(event.phase, event.scope);
    addPromptMetric(tokenBucketFor(summary.byTurn, turnId), event);
    addPromptMetric(tokenBucketFor(summary.byPhase, phase), event);
    addPromptMetric(tokenBucketFor(summary.byTurnPhase, `${turnId}:${phase}`), event);
    if (!event.promptCacheKey) summary.promptCache.missingKeyCount += 1;
    if (!event.promptCacheRetention) summary.promptCache.missingRetentionCount += 1;
    if (event.budgetState) {
      summary.budgetStates[turnId] = event.budgetState;
    }
    for (const section of event.promptSections ?? []) {
      if (!section.id.trim()) continue;
      const bucket = summary.bySection[section.id] ?? {
        requestCount: 0,
        chars: 0,
        estimatedTokens: 0,
      };
      bucket.requestCount += 1;
      bucket.chars += Number.isFinite(section.chars) ? Math.max(0, section.chars) : 0;
      bucket.estimatedTokens += Number.isFinite(section.estimatedTokens)
        ? Math.max(0, section.estimatedTokens)
        : 0;
      summary.bySection[section.id] = bucket;
    }
  }

  if (summary.promptTokens > 0) {
    summary.cacheHitRatio = summary.cachedTokens / summary.promptTokens;
  }

  return summary;
}

function providerIdFromModel(model: string): string {
  const trimmed = model.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex > 0) return trimmed.slice(0, slashIndex);
  return "custom";
}

function telemetryProviderAdapter(providerId: string): UsageProviderAdapter {
  return {
    providerId,
    summarize(events) {
      const providerEvents = events.filter(
        (event) => providerIdFromModel(event.model) === providerId,
      );
      if (providerEvents.length === 0) return null;
      const bucket = emptyTokenBucket();
      for (const event of providerEvents) addPromptMetric(bucket, event);
      return {
        ...bucket,
        providerId,
        source: "local_telemetry",
        remaining: {
          available: false,
          reason: "Provider quota adapter is not configured.",
        },
        billing: {
          available: false,
          reason: "Provider billing adapter is not configured.",
        },
      };
    },
  };
}

function summarizeProviderUsage(
  events: PromptCacheMetricEvent[],
): UsageProviderSummary {
  const providerIds = Array.from(
    new Set(events.map((event) => providerIdFromModel(event.model))),
  ).sort((left, right) => left.localeCompare(right));
  const providers = providerIds
    .map((providerId) => telemetryProviderAdapter(providerId).summarize(events))
    .filter((provider): provider is UsageProviderView => Boolean(provider))
    .sort((left, right) =>
      right.totalTokens - left.totalTokens ||
      right.promptTokens - left.promptTokens ||
      left.providerId.localeCompare(right.providerId),
    );
  return {
    activeProviderId: providers[0]?.providerId ?? null,
    providers,
  };
}

export function readUsageMonitor(input: {
  butlerData: string;
  sessionId?: string;
  sinceTs?: number | null;
}): UsageMonitorSummary {
  const sinceTs = typeof input.sinceTs === "number" ? input.sinceTs : null;
  const promptEvents = readPromptCacheMetrics({
    butlerData: input.butlerData,
    sinceTs: sinceTs ?? undefined,
  });
  return {
    filters: {
      sessionId: input.sessionId?.trim() || null,
      sinceTs,
    },
    model: summarizeModelUsage(promptEvents),
    webSearch: summarizeWebSearchUsage({
      butlerData: input.butlerData,
      sinceTs,
    }),
    tools: summarizeToolUsage({
      butlerData: input.butlerData,
      sessionId: input.sessionId,
      sinceTs,
    }),
    providerUsage: summarizeProviderUsage(promptEvents),
    cost: {
      available: false,
      estimatedUsd: null,
      reason: "No authoritative provider price table is configured for this runtime/model.",
    },
    privacy: {
      rawTextStored: false,
      rawToolArgumentsIncluded: false,
      rawToolResultsIncluded: false,
    },
  };
}
