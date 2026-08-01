import type { FunctionToolPromptOptions, OpenAIResponse, PromptOptions } from "../runtime-contracts.ts";
import type { HostedRuntimeConfig } from "./model-routing.ts";
import { activeFunctionTools, afterAttributedModelResponse, beforeAttributedModelRequest, finalNoToolInstructions, modelIterationLimitWithinUsageBudget, prepareFunctionToolCall } from "./runtime-support.ts";
import { createHostedChatCompletion, extractHostedChatToolCalls, firstHostedChatMessage, hostedChatCompletionsUrl, type HostedChatMessage, hostedChatReasoningParams, hostedChatResponseFormat, hostedChatText, hostedChatTools, hostedProviderErrorLabel, promptTextForHosted } from "./hosted-chat-client.ts";
import { hostedToolResultContent } from "./hosted-tool-result-context.ts";
import { providerEmptyResponseError, safeEndpointLabel } from "../provider-errors.ts";
import { recordPromptCacheMetric } from "../openai/runtime.ts";
import { toolBatchCompletedHandoffText } from "../../../agent/model-tool-loop/index.ts";
import { reviewProviderFinalCandidate } from "./final-candidate-review.ts";



export async function runHostedOpenAICompatiblePromptText(
  config: HostedRuntimeConfig,
  options: PromptOptions,
): Promise<string> {
  const messages: HostedChatMessage[] = [];
  if (options.instructions?.trim()) {
    messages.push({ role: "system", content: options.instructions.trim() });
  }
  messages.push({ role: "user", content: promptTextForHosted(options) });
  const responseFormat = hostedChatResponseFormat(options.responseFormat);
  beforeAttributedModelRequest({
    attribution: options.usageAttribution,
    roundIndex: options.usageAttribution?.roundIndex ?? 0,
  });
  const response = await createHostedChatCompletion(config, {
    messages,
    stream: true,
    ...hostedChatReasoningParams(config, options.reasoningEffort),
    ...(responseFormat ? { response_format: responseFormat } : {}),
  }, options.signal, {
    attribution: options.usageAttribution,
    roundIndex: options.usageAttribution?.roundIndex ?? 0,
  }, options.providerRetryAttempts);
  recordHostedOpenAICompatibleUsage({
    config,
    options,
    response,
    roundIndex: options.usageAttribution?.roundIndex ?? 0,
  });
  const text = hostedChatText(firstHostedChatMessage(response));
  if (!text) {
    throw providerEmptyResponseError({
      provider: hostedProviderErrorLabel(config),
      api: "chat_completions",
      endpoint: safeEndpointLabel(hostedChatCompletionsUrl(config)),
      model: config.modelId,
    });
  }
  return text;
}



export async function runHostedOpenAICompatibleFunctionToolPromptText(
  config: HostedRuntimeConfig,
  options: FunctionToolPromptOptions,
): Promise<string> {
  const log = options.log ?? (() => {});
  const maxRounds = modelIterationLimitWithinUsageBudget(
    options.maxToolRounds ?? 8,
    options.usageAttribution,
  );
  const messages: HostedChatMessage[] = [];
  if (options.instructions?.trim()) {
    messages.push({ role: "system", content: options.instructions.trim() });
  }
  messages.push({ role: "user", content: promptTextForHosted(options) });
  let toolBatchExecuted = false;

  for (let round = 0; round < maxRounds; round += 1) {
    const activeTools = activeFunctionTools(options);
    const allowedNames = new Set(activeTools.map((tool) => tool.name));
    beforeAttributedModelRequest({
      attribution: options.usageAttribution,
      roundIndex: round,
    });
    const response = await createHostedChatCompletion(config, {
      messages,
      tools: hostedChatTools(activeTools),
      tool_choice: options.toolChoice ?? "auto",
      stream: true,
      ...hostedChatReasoningParams(config, options.reasoningEffort),
    }, options.signal, { attribution: options.usageAttribution, roundIndex: round }, options.providerRetryAttempts);
    observeProviderIdentity(config, options, response);
    recordHostedOpenAICompatibleUsage({ config, options, response, roundIndex: round });
    const assistant = firstHostedChatMessage(response);
    const text = hostedChatText(assistant);
    const toolCalls = extractHostedChatToolCalls(assistant, allowedNames);
    if (toolCalls.length === 0) {
      if (!text) {
        throw providerEmptyResponseError({
          provider: hostedProviderErrorLabel(config),
          api: "chat_completions",
          endpoint: safeEndpointLabel(hostedChatCompletionsUrl(config)),
          model: config.modelId,
        });
      }
      const disposition = await reviewProviderFinalCandidate({ options, text, roundIndex: round });
      if (disposition.kind === "final") return disposition.text;
      messages.push({ role: "assistant", content: text });
      messages.push({ role: "user", content: disposition.observation });
      continue;
    }
    const preparedCalls = toolCalls.map((call) => ({
      call,
      prepared: prepareFunctionToolCall({
        name: call.function.name,
        rawArguments: call.function.arguments,
        tools: activeTools,
      }),
    }));
    await options.onAssistantTextBeforeTools?.({
      text,
      toolCalls: preparedCalls.map(({ call, prepared }) => ({
        name: call.function.name,
        args: prepared.args,
      })),
    });
    messages.push({
      role: "assistant",
      content: text || null,
      tool_calls: toolCalls,
    });
    toolBatchExecuted = true;
    for (const { call, prepared } of preparedCalls) {
      log(`tool ${call.function.name}: ${prepared.rawArguments}`);
      let payload = prepared.errorPayload;
      if (!payload) {
        try {
          payload = {
            ok: true,
            output: await options.executeTool({
              name: call.function.name,
              args: prepared.args,
              rawArguments: prepared.rawArguments,
              signal: options.signal,
            }),
          };
        } catch (error) {
          payload = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      const finalText = payload.ok
        ? await options.finalTextFromToolResult?.({
            name: call.function.name,
            args: prepared.args,
            output: payload.output,
          })
        : null;
      if (finalText?.trim()) return finalText.trim();
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: hostedToolResultContent({
          payload,
          toolName: call.function.name,
          toolCallId: call.id,
          log,
        }),
      });
    }
  }

  if (options.handoffAfterToolBatch && toolBatchExecuted) {
    return toolBatchCompletedHandoffText();
  }
  messages.push({ role: "user", content: finalNoToolInstructions(options.instructions) });
  beforeAttributedModelRequest({
    attribution: options.usageAttribution,
    roundIndex: maxRounds,
  });
  const response = await createHostedChatCompletion(config, {
    messages,
    stream: true,
    ...hostedChatReasoningParams(config, options.reasoningEffort),
  }, options.signal, { attribution: options.usageAttribution, roundIndex: maxRounds }, options.providerRetryAttempts);
  observeProviderIdentity(config, options, response);
  recordHostedOpenAICompatibleUsage({ config, options, response, roundIndex: maxRounds });
  const text = hostedChatText(firstHostedChatMessage(response));
  if (!text) {
    throw providerEmptyResponseError({
      provider: hostedProviderErrorLabel(config),
      api: "chat_completions",
      endpoint: safeEndpointLabel(hostedChatCompletionsUrl(config)),
      model: config.modelId,
    });
  }
  return text;
}

function observeProviderIdentity(
  config: HostedRuntimeConfig,
  options: FunctionToolPromptOptions,
  response: Record<string, any>,
): void {
  if (!options.onProviderResponseIdentity) return;
  const reportedModel = typeof response.model === "string" ? response.model.trim() : "";
  if (!reportedModel) {
    throw new Error(`provider_response_model_missing:${config.modelRef}`);
  }
  options.onProviderResponseIdentity({
    provider: config.providerId,
    configuredModel: config.modelRef,
    reportedModel,
  });
}



export function recordHostedOpenAICompatibleUsage(input: {
  config: HostedRuntimeConfig;
  options: PromptOptions;
  response: Record<string, any>;
  roundIndex: number;
}): void {
  const usageResponse = input.response as unknown as OpenAIResponse;
  afterAttributedModelResponse({
    attribution: input.options.usageAttribution,
    model: input.config.modelRef,
    response: usageResponse,
    roundIndex: input.roundIndex,
  });
  recordPromptCacheMetric(usageResponse, {
    model: input.config.modelRef,
    scope: input.options.cacheScope ?? "session-turn",
    promptCache: {},
    butlerData: input.options.butlerData,
    usageAttribution: {
      ...input.options.usageAttribution,
      reasoningEffort: input.options.reasoningEffort,
      roundIndex: input.roundIndex,
    },
  });
}
