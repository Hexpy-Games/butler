import type {
  ModelRoundRequest,
  ModelRoundResult,
} from "../../../agent/btcc/ports/model-round.ts";
import {
  createProviderRequestAttributor,
  localUserContentWithAttachments,
  openAICompatibleUsageSample,
  parseToolArguments,
  type ProviderUsageSample,
} from "../shared/runtime-support.ts";
import {
  localChatTools,
  localReasoningRequestParams,
  type LocalChatMessage,
  extractLocalChatText,
  extractLocalToolCalls,
  standaloneLocalFunctionCallNames,
} from "./protocol.ts";
import { createLocalChatCompletion, firstLocalAssistantMessage } from "./client.ts";
import { localFunctionToolInstructions } from "../shared/tools.ts";
import type { LocalModelConfig } from "./models.ts";

export async function runLocalModelRound(
  config: LocalModelConfig,
  request: ModelRoundRequest,
): Promise<ModelRoundResult> {
  const requests = createProviderRequestAttributor({
    attribution: request.usageAttribution,
    butlerData: request.butlerData,
    cacheScope: request.cacheScope,
  });
  const response = await requests.request({
    model: config.model_ref,
    run: async (context) => await createLocalChatCompletion(config, {
      messages: localModelRoundMessages(request),
      ...(request.tools.length > 0
        ? { tools: localChatTools(request.tools.map(modelRoundTool)) }
        : {}),
      tool_choice: request.toolChoice ?? "auto",
      ...localReasoningRequestParams(config),
      stream: false,
    }, request.signal, context, undefined, request.providerRetryAttempts),
    usage: openAICompatibleUsageSample,
  });
  const assistant = firstLocalAssistantMessage(response);
  const text = extractLocalChatText(assistant);
  const allowedNames = new Set(request.tools.map((tool) => tool.name));
  const providerCalls = extractLocalToolCalls(assistant, allowedNames);
  const textToolCallNames = providerCalls.some((call) => call.origin === "text")
    ? []
    : standaloneLocalFunctionCallNames(text, allowedNames);
  const toolCalls = providerCalls.map((call) => {
    const rawArguments = typeof call.function.arguments === "string"
      ? call.function.arguments
      : JSON.stringify(call.function.arguments ?? {});
    return {
      id: call.id,
      name: call.function.name,
      arguments: parseToolArguments(rawArguments),
      rawArguments,
      ...(call.origin ? { origin: call.origin } : {}),
    };
  });
  const usageSample = openAICompatibleUsageSample(response);
  return {
    ...(text ? { text } : {}),
    toolCalls,
    ...(textToolCallNames.length > 0 ? { textToolCallNames } : {}),
    assistantMessage: {
      role: "assistant",
      content: text,
      toolCalls,
      providerData: assistant,
    },
    usage: usageSample ? usageReport(config.model_ref, usageSample) : null,
    raw: response,
  };
}

function modelRoundTool(tool: ModelRoundRequest["tools"][number]) {
  return {
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

function localModelRoundMessages(request: ModelRoundRequest): LocalChatMessage[] {
  const firstUser = request.messages.findIndex((message) => message.role === "user");
  const messages: LocalChatMessage[] = [];
  const instructions = request.tools.length > 0
    ? localFunctionToolInstructions(request.instructions)
    : request.instructions;
  if (instructions?.trim()) {
    messages.push({ role: "system", content: instructions.trim() });
  }
  for (const [index, message] of request.messages.entries()) {
    if (message.role === "system") continue;
    if (message.role === "assistant") {
      messages.push({
        role: "assistant",
        content: message.content || null,
        ...(message.toolCalls && message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: call.rawArguments },
              })),
            }
          : {}),
      });
      continue;
    }
    if (message.role === "tool") {
      messages.push({
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId,
        ...(message.name ? { name: message.name } : {}),
      });
      continue;
    }
    messages.push({
      role: "user",
      content: index === firstUser
        ? localUserContentWithAttachments(message.content, request.attachments ? [...request.attachments] : undefined)
        : message.content,
    });
  }
  return messages;
}

function usageReport(model: string, sample: ProviderUsageSample) {
  return {
    model,
    promptTokens: sample.promptTokens,
    cachedTokens: sample.cachedTokens,
    totalTokens: sample.totalTokens,
    outputTokens: sample.outputTokens,
  };
}
