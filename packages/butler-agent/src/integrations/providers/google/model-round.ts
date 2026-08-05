import type {
  ModelRoundRequest,
  ModelRoundResult,
} from "../../../agent/btcc/ports/model-round.ts";
import { parseToolArguments } from "../shared/runtime-support.ts";
import { promptTextForHosted } from "../shared/hosted-openai-compatible.ts";
import { toolResultPayloadForProvider } from "../../../agent/tools/tool-result-serialization.ts";
import type { FunctionToolDefinition } from "../runtime-contracts.ts";
import {
  createProviderRequestAttributor,
  type ProviderUsageSample,
} from "../shared/runtime-support.ts";
import {
  createGeminiContent,
  geminiText,
  geminiTools,
  geminiReasoningParams,
  geminiUsageSample,
} from "./runtime.ts";
import type { HostedRuntimeConfig } from "../shared/model-routing.ts";

export async function runGeminiModelRound(
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
    run: async (context) => await createGeminiContent(config, {
      ...(request.instructions?.trim()
        ? { systemInstruction: { parts: [{ text: request.instructions.trim() }] } }
        : {}),
      ...geminiReasoningParams(request.reasoningEffort),
      contents: geminiModelRoundMessages(request),
      ...(request.tools.length > 0
        ? { tools: geminiTools(request.tools.map(modelRoundTool)) }
        : {}),
      ...(request.toolChoice === "required"
        ? { toolConfig: { functionCallingConfig: { mode: "ANY" } } }
        : {}),
    }, request.signal, context),
    usage: geminiUsageSample,
  });
  const parts = response.candidates?.[0]?.content?.parts;
  const responseParts = Array.isArray(parts) ? parts : [];
  const text = geminiText(response);
  const toolCalls = responseParts.flatMap((part: any, partIndex: number) => {
    const functionCall = part?.functionCall;
    if (typeof functionCall?.name !== "string" || !functionCall.name.trim()) return [];
    const rawArguments = typeof functionCall.args === "string"
      ? functionCall.args
      : JSON.stringify(functionCall.args ?? {});
    return [{
      id: `gemini_call_${request.usageAttribution?.roundIndex ?? 0}_${partIndex}_${functionCall.name}`,
      name: functionCall.name,
      arguments: parseToolArguments(rawArguments),
      rawArguments,
    }];
  });
  const usageSample = geminiUsageSample(response);
  const reportedModel = typeof response.modelVersion === "string"
    ? response.modelVersion.trim()
    : typeof response.model === "string"
      ? response.model.trim()
      : "";
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
      providerData: responseParts,
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

function geminiModelRoundMessages(request: ModelRoundRequest): Array<Record<string, unknown>> {
  const firstUser = request.messages.findIndex((message) => message.role === "user");
  return request.messages.flatMap((message, index) => {
    if (message.role === "system") return [];
    if (message.role === "assistant") {
      const providerData = Array.isArray(message.providerData)
        ? message.providerData
        : [
            ...(message.content ? [{ text: message.content }] : []),
            ...(message.toolCalls ?? []).map((call) => ({
              functionCall: { name: call.name, args: call.arguments },
            })),
          ];
      return [{ role: "model", parts: providerData }];
    }
    if (message.role === "tool") {
      let response: Record<string, unknown>;
      try {
        const parsed = JSON.parse(message.content) as unknown;
        response = parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : { output: parsed };
      } catch {
        response = { output: message.content };
      }
      return [{
        role: "user",
        parts: [{
          functionResponse: {
            name: message.name ?? "unknown_tool",
            response: toolResultPayloadForProvider(response, { toolName: message.name }),
          },
        }],
      }];
    }
    const content = index === firstUser
      ? promptTextForHosted({ prompt: message.content, attachments: [...(request.attachments ?? [])] })
      : message.content;
    return [{ role: "user", parts: [{ text: content }] }];
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
