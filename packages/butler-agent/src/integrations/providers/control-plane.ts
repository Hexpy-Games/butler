import {
  getOpenAIAuthSummary,
  getRuntimeControlPlaneSummary,
  type OpenAIAuthSummary,
  type RuntimeControlPlaneSummary,
} from "./provider.ts";
import {
  readPromptCacheMetrics,
  summarizePromptCacheMetrics,
  type PromptCacheMetricSummary,
} from "./prompt-cache-metrics.ts";

export interface ModelProviderControlStatus {
  runtime: RuntimeControlPlaneSummary["runtime"];
  provider: string;
  model: string;
  modelRef: string;
  auth: {
    configured: boolean;
    mode: OpenAIAuthSummary["mode"] | "missing";
    source: OpenAIAuthSummary["envKey"] | null;
  };
  promptCache: RuntimeControlPlaneSummary["promptCache"] & {
    telemetry: PromptCacheMetricSummary;
  };
}

export function getModelProviderControlStatus(options: {
  model?: string;
  cacheScope?: string;
  sinceTs?: number;
  authOverride?: OpenAIAuthSummary | null;
} = {}): ModelProviderControlStatus {
  const control = getRuntimeControlPlaneSummary({
    model: options.model,
    cacheScope: options.cacheScope,
  });
  let auth: ModelProviderControlStatus["auth"];
  if (options.authOverride === null) {
    auth = {
      configured: false,
      mode: "missing",
      source: null,
    };
  } else if (options.authOverride) {
    auth = {
      configured: true,
      mode: options.authOverride.mode,
      source: options.authOverride.envKey,
    };
  } else {
    try {
      const summary = getOpenAIAuthSummary();
      auth = {
        configured: true,
        mode: summary.mode,
        source: summary.envKey,
      };
    } catch {
      auth = {
        configured: false,
        mode: "missing",
        source: null,
      };
    }
  }
  const telemetry = summarizePromptCacheMetrics(readPromptCacheMetrics({
    sinceTs: options.sinceTs,
  }));
  return {
    runtime: control.runtime,
    provider: control.providerId,
    model: control.modelId,
    modelRef: control.modelRef,
    auth,
    promptCache: {
      ...control.promptCache,
      telemetry,
    },
  };
}

export function renderModelProviderControlStatus(status: ModelProviderControlStatus): string {
  const telemetry = status.promptCache.telemetry;
  const ratio = telemetry.promptTokens > 0
    ? `${(telemetry.cacheHitRatio * 100).toFixed(1)}%`
    : "n/a";
  return [
    `Runtime: ${status.runtime}`,
    `Provider: ${status.provider}`,
    `Model: ${status.model}`,
    `Model ref: ${status.modelRef}`,
    `Auth: ${status.auth.configured ? status.auth.mode : "missing"}${status.auth.source ? ` (${status.auth.source})` : ""}`,
    `Prompt cache policy: supported=${status.promptCache.supported} configured=${status.promptCache.configured} retention=${status.promptCache.retention ?? "none"} key=${status.promptCache.effectiveKey ?? "none"}`,
    `Prompt cache telemetry: requests=${telemetry.requestCount} cached=${telemetry.cachedTokens}/${telemetry.promptTokens} hit=${ratio}`,
  ].join("\n");
}
