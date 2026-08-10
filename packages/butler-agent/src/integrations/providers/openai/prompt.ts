import type { OpenAIAuthOverride, PromptTextResult } from "../runtime-contracts.ts";
import { afterAttributedModelResponse, beforeAttributedModelRequest, extractPromptCacheStats, extractResponseText } from "../shared/runtime-support.ts";
import { buildReasoningConfig, getResponsesUrl, resolveOpenAIModel, resolveOpenAIPromptCacheConfig } from "./config.ts";
import { createOpenAIResponse } from "./responses.ts";
import { providerEmptyResponseError, safeEndpointLabel } from "../provider-errors.ts";
import { recordPromptCacheMetric } from "./usage.ts";
import { resolveDynamicOpenAIModel } from "./models.ts";
import type { PromptCacheAwarePromptOptions } from "../prompt-cache-boundary.ts";
import { openAIPromptCacheRequest } from "./prompt-cache-request.ts";
import { resolveOpenAIAuth } from "./auth.ts";


export async function runOpenAIPromptWithUsage(
  options: PromptCacheAwarePromptOptions,
  authOverride?: OpenAIAuthOverride,
  modelOverride?: string,
): Promise<PromptTextResult> {
  const resolution = resolveOpenAIModel(modelOverride ?? options.model, options.reasoningEffort);
  const model = await resolveDynamicOpenAIModel(resolution.model);
  const auth = authOverride ?? await resolveOpenAIAuth();
  const promptCache = resolveOpenAIPromptCacheConfig(options.cacheScope ?? "text-prompt");
  const cacheRequest = openAIPromptCacheRequest({
    model,
    prompt: options.prompt,
    attachments: options.attachments,
    boundary: options.promptCacheBoundary,
    configured: promptCache,
    authMode: auth.mode,
  });
  beforeAttributedModelRequest({
    attribution: options.usageAttribution,
    roundIndex: options.usageAttribution?.roundIndex ?? 0,
  });
  const response = await createOpenAIResponse({
    model,
    store: true,
    ...cacheRequest.cache,
    instructions: options.instructions,
    ...(options.responseFormat ? { text: { format: options.responseFormat } } : {}),
    reasoning: buildReasoningConfig(resolution),
    input: cacheRequest.input,
  }, options.signal, auth, options.onProviderStreamEvent, {
    attribution: options.usageAttribution,
    roundIndex: options.usageAttribution?.roundIndex ?? 0,
  }, undefined, options.providerRetryAttempts);
  afterAttributedModelResponse({
    attribution: options.usageAttribution,
    model,
    response,
    roundIndex: options.usageAttribution?.roundIndex ?? 0,
  });
  recordPromptCacheMetric(response, {
    model,
    scope: options.cacheScope ?? "text-prompt",
    promptCache: cacheRequest.telemetry,
    butlerData: options.butlerData,
    usageAttribution: {
      ...options.usageAttribution,
      reasoningEffort: resolution.reasoningEffort,
    },
  });
  const text = extractResponseText(response);
  if (!text) {
    throw providerEmptyResponseError({
      provider: "openai",
      api: "responses",
      endpoint: safeEndpointLabel(getResponsesUrl()),
      model,
    });
  }
  const stats = extractPromptCacheStats(response);
  return {
    text,
    model,
    usage: stats
      ? {
          model,
          promptTokens: stats.promptTokens,
          cachedTokens: stats.cachedTokens,
          totalTokens: stats.totalTokens,
          outputTokens: stats.outputTokens ?? (stats.totalTokens === null || stats.promptTokens === null
            ? 0
            : Math.max(0, stats.totalTokens - stats.promptTokens)),
          providerPromptTokens: stats.promptTokens,
          providerCacheReadTokens: stats.providerCacheReadTokens ?? null,
          providerCacheWriteTokens: stats.cacheWriteTokens,
          providerOutputTokens: stats.outputTokens,
          providerTotalTokens: stats.totalTokens,
        }
      : null,
  };
}
