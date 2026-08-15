import {
  visitWebSearchMetricEvents,
  readWebSearchMetrics,
} from "../../integrations/search/provider.ts";
import {
  visitPromptCacheMetrics,
} from "../../integrations/providers/prompt-cache-metrics.ts";
import {
  ensureTranscriptActivityAggregateStatus,
} from "./transcript-activity-index.ts";
import type { TranscriptActivityAvailability } from "./transcript-activity-index.ts";
import {
  addModelUsageEvent,
  addProviderUsageEvent,
  createModelUsageSummary,
  finalizeModelUsage,
  summarizeProviderUsageBuckets,
} from "./usage-monitor-model.ts";
import { summarizeToolUsage } from "./usage-monitor-tools.ts";
import type { ProviderQuotaResult } from "./provider-quota.ts";

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
  availability: {
    transcriptActivity: {
      status: TranscriptActivityAvailability;
      reason: string | null;
    };
    tools: {
      status: "available" | "unavailable";
      reason: string | null;
    };
  };
}

export interface UsageProviderView extends UsageTokenBucket {
  providerId: string;
  source: "local_telemetry" | "provider_adapter";
  remaining: ProviderQuotaResult;
  billing: {
    available: boolean;
    reason: string;
  };
}

export interface UsageProviderSummary {
  activeProviderId: string | null;
  providers: UsageProviderView[];
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

  let requestCount = 0;
  let lastProvider: string | null = null;
  let lastError: string | null = null;
  let latestTs = Number.NEGATIVE_INFINITY;
  visitWebSearchMetricEvents({
    butlerData: input.butlerData,
    sinceTs: input.sinceTs,
    onEvent: (event) => {
      requestCount += 1;
      if (event.ts >= latestTs) {
        latestTs = event.ts;
        lastProvider = event.provider;
        lastError = event.error ?? null;
      }
    },
  });
  return {
    requestCount,
    lastProvider,
    lastError,
  };
}

export function readUsageMonitor(input: {
  butlerData: string;
  sessionId?: string;
  sinceTs?: number | null;
}): UsageMonitorSummary {
  const sinceTs = typeof input.sinceTs === "number" ? input.sinceTs : null;
  const isUnscoped = !input.sessionId?.trim();
  const transcriptActivity = sinceTs === null && isUnscoped
    ? ensureTranscriptActivityAggregateStatus({ butlerData: input.butlerData })
    : null;
  const toolsAvailability = sinceTs !== null && isUnscoped
    ? {
        status: "unavailable" as const,
        reason: "unscoped_since_filter_requires_session",
      }
    : {
        status: "available" as const,
        reason: null,
      };
  const model = createModelUsageSummary();
  const providerBuckets = new Map<string, UsageTokenBucket>();
  visitPromptCacheMetrics({
    butlerData: input.butlerData,
    sinceTs: sinceTs ?? undefined,
    onEvent: (event) => {
      addModelUsageEvent(model, event);
      addProviderUsageEvent(providerBuckets, event);
    },
  });
  return {
    filters: {
      sessionId: input.sessionId?.trim() || null,
      sinceTs,
    },
    model: finalizeModelUsage(model),
    webSearch: summarizeWebSearchUsage({
      butlerData: input.butlerData,
      sinceTs,
    }),
    tools: summarizeToolUsage({
      butlerData: input.butlerData,
      sessionId: input.sessionId,
      sinceTs,
      aggregate: transcriptActivity ?? undefined,
    }),
    providerUsage: summarizeProviderUsageBuckets(providerBuckets),
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
    availability: {
      transcriptActivity: transcriptActivity
        ? {
            status: transcriptActivity.availability,
            reason: transcriptActivity.reason,
          }
        : { status: "available", reason: null },
      tools: toolsAvailability,
    },
  };
}
