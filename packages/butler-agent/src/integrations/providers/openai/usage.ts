import type { OpenAIPromptCacheConfig, OpenAIResponse, PromptUsageAttribution } from "../runtime-contracts.ts";
import { appendPromptCacheMetric } from "../prompt-cache-metrics.ts";
import { extractPromptCacheStats } from "../shared/runtime-support.ts";



export function logPromptCacheStats(
  response: OpenAIResponse,
  log: (line: string) => void,
  promptCache: OpenAIPromptCacheConfig,
): void {
  const stats = extractPromptCacheStats(response);
  if (!stats) return;

  const parts = [
    `responses usage: prompt_tokens=${stats.promptTokens ?? "?"}`,
    `cached_tokens=${stats.cachedTokens}`,
    `cache_write_tokens=${stats.cacheWriteTokens ?? "?"}`,
    `total_tokens=${stats.totalTokens ?? "?"}`,
  ];
  if (promptCache.prompt_cache_key) {
    parts.push(`prompt_cache_key=${promptCache.prompt_cache_key}`);
  }
  if (promptCache.prompt_cache_retention) {
    parts.push(`prompt_cache_retention=${promptCache.prompt_cache_retention}`);
  }
  log(parts.join(" "));
}



export function recordPromptCacheMetric(
  response: OpenAIResponse,
  input: {
    model: string;
    scope: string;
    promptCache: OpenAIPromptCacheConfig;
    butlerData?: string;
    usageAttribution?: PromptUsageAttribution;
  },
): void {
  const stats = extractPromptCacheStats(response);
  if (!stats || stats.promptTokens === null) return;

  appendPromptCacheMetric({
    ts: Date.now(),
    model: input.model,
    scope: input.scope,
    turnId: input.usageAttribution?.turnId,
    phase: input.usageAttribution?.phase,
    roundIndex: input.usageAttribution?.roundIndex,
    reasoningEffort: input.usageAttribution?.reasoningEffort,
    promptTokens: stats.promptTokens,
    cachedTokens: stats.cachedTokens,
    ...(stats.cacheWriteTokens === null
      ? {}
      : { cacheWriteTokens: stats.cacheWriteTokens }),
    totalTokens: stats.totalTokens,
    promptCacheKey: input.promptCache.prompt_cache_key,
    promptCacheRetention: input.promptCache.prompt_cache_retention,
    budgetState: input.usageAttribution?.getBudgetState?.() ?? input.usageAttribution?.budgetState,
    promptSections: input.usageAttribution?.promptSections,
  }, { butlerData: input.butlerData });
}
