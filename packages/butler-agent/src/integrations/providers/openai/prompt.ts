import type { OpenAIAuthOverride, PromptOptions, PromptTextResult } from "../runtime-contracts.ts";
import { afterAttributedModelResponse, beforeAttributedModelRequest, extractPromptCacheStats, extractResponseText, openAIInputWithAttachments } from "../shared/runtime-support.ts";
import { buildReasoningConfig, getResponsesUrl, resolveOpenAIModel, resolveOpenAIPromptCacheConfig } from "./config.ts";
import { createOpenAIResponse } from "./responses.ts";
import { providerEmptyResponseError, safeEndpointLabel } from "../provider-errors.ts";
import { recordPromptCacheMetric } from "./usage.ts";
import { resolveDynamicOpenAIModel } from "./models.ts";


export async function runOpenAIPromptWithUsage(
  options: PromptOptions,
  authOverride?: OpenAIAuthOverride,
  modelOverride?: string,
): Promise<PromptTextResult> {
  const resolution = resolveOpenAIModel(modelOverride ?? options.model, options.reasoningEffort);
  const model = await resolveDynamicOpenAIModel(resolution.model);
  const promptCache = resolveOpenAIPromptCacheConfig(options.cacheScope ?? "text-prompt");
  beforeAttributedModelRequest({
    attribution: options.usageAttribution,
    roundIndex: options.usageAttribution?.roundIndex ?? 0,
  });
  const response = await createOpenAIResponse({
    model,
    store: true,
    ...promptCache,
    instructions: options.instructions,
    ...(options.responseFormat ? { text: { format: options.responseFormat } } : {}),
    reasoning: buildReasoningConfig(resolution),
    input: openAIInputWithAttachments(options.prompt, options.attachments),
  }, options.signal, authOverride, options.onProviderStreamEvent, {
    attribution: options.usageAttribution,
    roundIndex: options.usageAttribution?.roundIndex ?? 0,
  });
  afterAttributedModelResponse({
    attribution: options.usageAttribution,
    model,
    response,
    roundIndex: options.usageAttribution?.roundIndex ?? 0,
  });
  recordPromptCacheMetric(response, {
    model,
    scope: options.cacheScope ?? "text-prompt",
    promptCache,
    butlerData: options.butlerData,
    usageAttribution: {
      ...options.usageAttribution,
      reasoningEffort: resolution.reasoningEffort,
      roundIndex: options.usageAttribution?.roundIndex ?? 0,
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
          outputTokens: stats.totalTokens === null || stats.promptTokens === null
            ? 0
            : Math.max(0, stats.totalTokens - stats.promptTokens),
        }
      : null,
  };
}
