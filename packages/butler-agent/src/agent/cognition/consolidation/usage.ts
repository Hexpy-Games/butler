import type { PromptUsageReport } from "../../../integrations/providers/provider.ts";
import type { PromptCacheMetricEvent } from "../../../integrations/providers/prompt-cache-metrics.ts";

export type ConsolidationModelUsageSummary = {
  request_count: number;
  prompt_tokens: number;
  cached_input_tokens: number;
  uncached_input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  models: string[];
  estimated_codex_5_5_credits: number;
  estimated_api_gpt_5_5_usd: number;
  rate_source: "openai_codex_rate_card_2026_05";
  raw_text_included: false;
};

export type ConsolidationPhaseUsageSummary = ConsolidationModelUsageSummary & {
  phase: string;
};

export type ConsolidationUsageReport = ConsolidationModelUsageSummary & {
  phases: ConsolidationPhaseUsageSummary[];
};

export const CODEX_GPT_5_5_RATE_SOURCE = "openai_codex_rate_card_2026_05" as const;

const CODEX_GPT_5_5_CREDITS_PER_1M = {
  input: 125,
  cachedInput: 12.5,
  output: 750,
};

const API_GPT_5_5_USD_PER_1M = {
  input: 5,
  cachedInput: 0.5,
  output: 30,
};

export function emptyModelUsageSummary(): ConsolidationModelUsageSummary {
  return finalizeUsage({
    request_count: 0,
    prompt_tokens: 0,
    cached_input_tokens: 0,
    uncached_input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    models: [],
  });
}

export function usageFromPromptUsageReports(
  reports: Array<{ model: string; usage?: PromptUsageReport | null }>,
): ConsolidationModelUsageSummary {
  const draft = {
    request_count: 0,
    prompt_tokens: 0,
    cached_input_tokens: 0,
    uncached_input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    models: [] as string[],
  };
  for (const report of reports) {
    draft.request_count += 1;
    const model = report.usage?.model || report.model;
    if (model && !draft.models.includes(model)) draft.models.push(model);
    const promptTokens = report.usage?.promptTokens;
    const cachedTokens = report.usage?.cachedTokens ?? 0;
    const totalTokens = report.usage?.totalTokens;
    if (typeof promptTokens === "number") {
      const safeCached = Math.max(0, Math.min(cachedTokens, promptTokens));
      draft.prompt_tokens += promptTokens;
      draft.cached_input_tokens += safeCached;
      draft.uncached_input_tokens += Math.max(0, promptTokens - safeCached);
    }
    if (typeof totalTokens === "number") {
      draft.total_tokens += totalTokens;
      if (typeof promptTokens === "number") {
        draft.output_tokens += Math.max(0, totalTokens - promptTokens);
      }
    }
  }
  return finalizeUsage(draft);
}

export function usageFromPromptCacheMetricEvents(
  events: PromptCacheMetricEvent[],
): ConsolidationModelUsageSummary {
  return usageFromPromptUsageReports(events.map((event) => ({
    model: event.model,
    usage: {
      model: event.model,
      promptTokens: event.promptTokens,
      cachedTokens: event.cachedTokens,
      totalTokens: typeof event.totalTokens === "number" ? event.totalTokens : null,
    },
  })));
}

export function modelUsageFromUnknown(value: unknown): ConsolidationModelUsageSummary | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const requestCount = finiteNumber(input.request_count);
  const promptTokens = finiteNumber(input.prompt_tokens);
  const cachedInputTokens = finiteNumber(input.cached_input_tokens);
  const uncachedInputTokens = finiteNumber(input.uncached_input_tokens);
  const outputTokens = finiteNumber(input.output_tokens);
  const totalTokens = finiteNumber(input.total_tokens);
  const models = Array.isArray(input.models)
    ? input.models.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  if (
    requestCount === null ||
    promptTokens === null ||
    cachedInputTokens === null ||
    uncachedInputTokens === null ||
    outputTokens === null ||
    totalTokens === null
  ) {
    return null;
  }
  return finalizeUsage({
    request_count: requestCount,
    prompt_tokens: promptTokens,
    cached_input_tokens: cachedInputTokens,
    uncached_input_tokens: uncachedInputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    models: [...new Set(models)].sort(),
  });
}

export function mergeModelUsage(
  left: ConsolidationModelUsageSummary,
  right: ConsolidationModelUsageSummary,
): ConsolidationModelUsageSummary {
  return finalizeUsage({
    request_count: left.request_count + right.request_count,
    prompt_tokens: left.prompt_tokens + right.prompt_tokens,
    cached_input_tokens: left.cached_input_tokens + right.cached_input_tokens,
    uncached_input_tokens: left.uncached_input_tokens + right.uncached_input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    total_tokens: left.total_tokens + right.total_tokens,
    models: [...new Set([...left.models, ...right.models])].sort(),
  });
}

function finalizeUsage(input: Omit<
  ConsolidationModelUsageSummary,
  "estimated_codex_5_5_credits" | "estimated_api_gpt_5_5_usd" | "rate_source" | "raw_text_included"
>): ConsolidationModelUsageSummary {
  return {
    ...input,
    estimated_codex_5_5_credits: roundCost(
      (input.uncached_input_tokens / 1_000_000) * CODEX_GPT_5_5_CREDITS_PER_1M.input +
        (input.cached_input_tokens / 1_000_000) * CODEX_GPT_5_5_CREDITS_PER_1M.cachedInput +
        (input.output_tokens / 1_000_000) * CODEX_GPT_5_5_CREDITS_PER_1M.output,
    ),
    estimated_api_gpt_5_5_usd: roundCost(
      (input.uncached_input_tokens / 1_000_000) * API_GPT_5_5_USD_PER_1M.input +
        (input.cached_input_tokens / 1_000_000) * API_GPT_5_5_USD_PER_1M.cachedInput +
        (input.output_tokens / 1_000_000) * API_GPT_5_5_USD_PER_1M.output,
    ),
    rate_source: CODEX_GPT_5_5_RATE_SOURCE,
    raw_text_included: false,
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function roundCost(value: number): number {
  return Number(value.toFixed(6));
}
