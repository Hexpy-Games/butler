import type {
  ModelRoundRequest,
  ModelRoundResult,
} from "../../../agent/btcc/ports/model-round.ts";
import {
  parseToolArguments,
  createProviderRequestAttributor,
  type ProviderUsageSample,
} from "../shared/runtime-support.ts";
import { promptTextForHosted } from "../shared/hosted-openai-compatible.ts";
import type { FunctionToolDefinition } from "../runtime-contracts.ts";
import {
  anthropicText,
  anthropicTools,
  anthropicUsageSample,
  anthropicReasoningParams,
  createAnthropicMessage,
} from "./runtime.ts";
import type { HostedRuntimeConfig } from "../shared/model-routing.ts";

export async function runAnthropicModelRound(
  config: HostedRuntimeConfig,
  request: ModelRoundRequest,
): Promise<ModelRoundResult> {
  const requests = createProviderRequestAttributor({
    attribution: request.usageAttribution,
    butlerData: request.butlerData,
    cacheScope: request.cacheScope,
  });
  const response = await requests.request({
    model: config.modelRef,
    run: async (context) => await createAnthropicMessage(config, {
      ...(request.instructions?.trim() ? { system: request.instructions.trim() } : {}),
      ...anthropicReasoningParams(config, request.reasoningEffort),
      messages: anthropicModelRoundMessages(request),
      ...(request.tools.length > 0
        ? { tools: anthropicTools(request.tools.map(modelRoundTool)) }
        : {}),
      ...(request.toolChoice === "required" ? { tool_choice: { type: "any" } } : {}),
    }, request.signal, context, request.providerRetryAttempts),
    usage: anthropicUsageSample,
  });
  const content = Array.isArray(response.content) ? response.content : [];
  const text = anthropicText(response);
  const toolCalls = content.flatMap((part: any) => {
    if (part?.type !== "tool_use" || typeof part.id !== "string" || typeof part.name !== "string") {
      return [];
    }
    const rawArguments = typeof part.input === "string"
      ? part.input
      : JSON.stringify(part.input ?? {});
    return [{
      id: part.id,
      name: part.name,
      arguments: parseToolArguments(rawArguments),
      rawArguments,
    }];
  });
  const usageSample = anthropicUsageSample(response);
  const reportedModel = typeof response.model === "string" ? response.model.trim() : "";
  const providerIdentity = reportedModel
    ? { provider: config.providerId, configuredModel: config.modelRef, reportedModel }
    : undefined;
  if (providerIdentity) request.onProviderResponseIdentity?.(providerIdentity);
  return {
    ...(text ? { text } : {}),
    toolCalls,
    assistantMessage: {
      role: "assistant",
      content: text,
      toolCalls,
      providerData: content,
    },
    usage: usageSample ? usageReport(config.modelRef, usageSample) : null,
    ...(providerIdentity ? { providerIdentity } : {}),
    raw: response,
  };
}

function modelRoundTool(tool: ModelRoundRequest["tools"][number]): FunctionToolDefinition {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

function anthropicModelRoundMessages(request: ModelRoundRequest): Array<Record<string, unknown>> {
  const firstUser = request.messages.findIndex((message) => message.role === "user");
  return request.messages.flatMap((message, index): Array<Record<string, unknown>> => {
    if (message.role === "system") return [];
    if (message.role === "assistant") {
      const providerData = Array.isArray(message.providerData)
        ? message.providerData
        : [
            ...(message.content ? [{ type: "text", text: message.content }] : []),
            ...(message.toolCalls ?? []).map((call) => ({
              type: "tool_use",
              id: call.id,
              name: call.name,
              input: call.arguments,
            })),
          ];
      return [{ role: "assistant", content: providerData }];
    }
    if (message.role === "tool") {
      return [{
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: message.content,
        }],
      }];
    }
    const content = index === firstUser
      ? promptTextForHosted({ prompt: message.content, attachments: [...(request.attachments ?? [])] })
      : message.content;
    return [{ role: "user", content }];
  });
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
