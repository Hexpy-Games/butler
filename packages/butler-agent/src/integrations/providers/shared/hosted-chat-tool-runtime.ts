import type { FunctionToolPromptOptions, OpenAIResponse, PromptOptions } from "../runtime-contracts.ts";
import type { HostedRuntimeConfig } from "./model-routing.ts";
import { activeFunctionTools, afterAttributedModelResponse, beforeAttributedModelRequest, finalNoToolInstructions, localToolArguments, modelIterationLimitWithinUsageBudget } from "./runtime-support.ts";
import { createHostedChatCompletion, extractHostedChatToolCalls, firstHostedChatMessage, hostedChatCompletionsUrl, type HostedChatMessage, hostedChatReasoningParams, hostedChatResponseFormat, hostedChatText, hostedChatTools, hostedProviderErrorLabel, promptTextForHosted } from "./hosted-chat-client.ts";
import {
  compactObservedHostedToolMessages,
  hostedToolResultContent,
} from "./hosted-tool-result-context.ts";
import { providerEmptyResponseError, safeEndpointLabel } from "../provider-errors.ts";
import { recordPromptCacheMetric } from "../openai/runtime.ts";
import { toolBatchCompletedHandoffText } from "../../../agent/turn/tool-batch-handoff.ts";
import {
  blockCapacityObservation,
  blockCapacityToolOutput,
  partitionSemanticToolBatch,
} from "../../../agent/turn/tool-batch-capacity.ts";
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
    stream: false,
    ...hostedChatReasoningParams(config, options.reasoningEffort),
    ...(responseFormat ? { response_format: responseFormat } : {}),
  }, options.signal);
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
      stream: false,
      ...hostedChatReasoningParams(config, options.reasoningEffort),
    }, options.signal);
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
      compactObservedHostedToolMessages({
        messages,
        log,
        evidenceRetention: {
          butlerData: options.butlerData,
          turnId: options.usageAttribution?.turnId,
        },
      });
      continue;
    }
    const batch = partitionSemanticToolBatch(toolCalls);
    await options.onAssistantTextBeforeTools?.({
      text,
      toolCalls: batch.executable.map((call) => {
        const args = localToolArguments(call.function.arguments);
        return {
          name: call.function.name,
          args: args.parsed,
        };
      }),
    });
    compactObservedHostedToolMessages({
      messages,
      log,
      evidenceRetention: {
        butlerData: options.butlerData,
        turnId: options.usageAttribution?.turnId,
      },
    });
    messages.push({
      role: "assistant",
      content: text || null,
      tool_calls: toolCalls,
    });
    toolBatchExecuted = true;
    for (const call of batch.executable) {
      const args = localToolArguments(call.function.arguments);
      log(`tool ${call.function.name}: ${args.raw}`);
      let payload: Record<string, unknown>;
      try {
        payload = {
          ok: true,
          output: await options.executeTool({
            name: call.function.name,
            args: args.parsed,
            rawArguments: args.raw,
          }),
        };
      } catch (error) {
        payload = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const finalText = payload.ok
        ? await options.finalTextFromToolResult?.({
            name: call.function.name,
            args: args.parsed,
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
          evidenceRetention: {
            butlerData: options.butlerData,
            turnId: options.usageAttribution?.turnId,
          },
        }),
      });
    }
    for (const call of batch.deferred) {
      const observation = blockCapacityObservation({
        toolCallId: call.id,
        toolName: call.function.name,
        deferredCount: batch.deferred.length,
        turnId: options.usageAttribution?.turnId,
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: hostedToolResultContent({
          payload: { ok: false, output: blockCapacityToolOutput(observation) },
          toolName: call.function.name,
          toolCallId: call.id,
          log,
          evidenceRetention: {
            butlerData: options.butlerData,
            turnId: options.usageAttribution?.turnId,
          },
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
    stream: false,
    ...hostedChatReasoningParams(config, options.reasoningEffort),
  }, options.signal);
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
