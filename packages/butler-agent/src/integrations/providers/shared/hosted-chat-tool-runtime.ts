import type {
  ModelRoundRequest,
  ModelRoundResult,
} from "../../../agent/btcc/ports/model-round.ts";
import type {
  FunctionToolDefinition,
  OpenAIResponse,
  PromptOptions,
} from "../runtime-contracts.ts";
import type { HostedRuntimeConfig } from "./model-routing.ts";
import {
  afterAttributedModelResponse,
  beforeAttributedModelRequest,
  openAICompatibleUsageSample,
  parseToolArguments,
} from "./runtime-support.ts";
import {
  createHostedChatCompletion,
  extractHostedChatToolCalls,
  firstHostedChatMessage,
  hostedChatCompletionsUrl,
  type HostedChatMessage,
  hostedChatReasoningParams,
  hostedChatResponseFormat,
  hostedChatText,
  hostedChatTools,
  hostedProviderErrorLabel,
  promptTextForHosted,
} from "./hosted-chat-client.ts";
import {
  providerEmptyResponseError,
  safeEndpointLabel,
} from "../provider-errors.ts";
import { recordPromptCacheMetric } from "../openai/runtime.ts";
import { serializeOpenAIChatVisualContent } from "../../../agent/image-attachment/index.ts";

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
  const roundIndex = options.usageAttribution?.roundIndex ?? 0;
  beforeAttributedModelRequest({
    attribution: options.usageAttribution,
    roundIndex,
  });
  const response = await createHostedChatCompletion(
    config,
    {
      messages,
      stream: true,
      ...hostedChatReasoningParams(config, options.reasoningEffort),
      ...(responseFormat ? { response_format: responseFormat } : {}),
    },
    options.signal,
    {
      attribution: options.usageAttribution,
      roundIndex,
    },
    options.providerRetryAttempts,
  );
  recordHostedOpenAICompatibleUsage({ config, options, response, roundIndex });
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

/** One provider request. BTCC owns continuation, tool execution, and review. */
export async function runHostedOpenAICompatibleModelRound(
  config: HostedRuntimeConfig,
  request: ModelRoundRequest,
): Promise<ModelRoundResult> {
  const roundIndex = request.usageAttribution?.roundIndex ?? 0;
  beforeAttributedModelRequest({
    attribution: request.usageAttribution,
    roundIndex,
  });
  const response = await createHostedChatCompletion(
    config,
    {
      messages: await hostedModelRoundMessages(request),
      ...(request.tools.length > 0
        ? { tools: hostedChatTools(request.tools.map(modelRoundTool)) }
        : {}),
      tool_choice: request.toolChoice ?? "auto",
      stream: true,
      ...hostedChatReasoningParams(config, request.reasoningEffort),
    },
    request.signal,
    {
      attribution: request.usageAttribution,
      roundIndex,
    },
    request.providerRetryAttempts,
  );
  recordHostedOpenAICompatibleUsage({
    config,
    options: request,
    response,
    roundIndex,
  });
  const assistant = firstHostedChatMessage(response);
  const text = hostedChatText(assistant);
  const toolCalls = extractHostedChatToolCalls(assistant).map((call) => {
    const rawArguments =
      typeof call.function.arguments === "string"
        ? call.function.arguments
        : JSON.stringify(call.function.arguments ?? {});
    return {
      id: call.id,
      name: call.function.name,
      arguments: parseToolArguments(rawArguments),
      rawArguments,
    };
  });
  const reportedModel =
    typeof response.model === "string" ? response.model.trim() : "";
  const providerIdentity = reportedModel
    ? {
        provider: config.providerId,
        configuredModel: config.modelRef,
        reportedModel,
      }
    : undefined;
  if (providerIdentity) request.onProviderResponseIdentity?.(providerIdentity);
  const sample = openAICompatibleUsageSample(response);
  return {
    ...(text ? { text } : {}),
    toolCalls,
    assistantMessage: {
      role: "assistant",
      content: text,
      toolCalls,
      providerData: assistant,
    },
    usage: sample
      ? {
          model: config.modelRef,
          promptTokens: sample.promptTokens,
          cachedTokens: sample.cachedTokens,
          totalTokens: sample.totalTokens,
          outputTokens: sample.outputTokens,
        }
      : null,
    ...(providerIdentity ? { providerIdentity } : {}),
    raw: response,
  };
}

function modelRoundTool(
  tool: ModelRoundRequest["tools"][number],
): FunctionToolDefinition {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.concurrencySafe === undefined
      ? {}
      : { concurrencySafe: tool.concurrencySafe }),
  };
}

async function hostedModelRoundMessages(
  request: ModelRoundRequest,
): Promise<HostedChatMessage[]> {
  const firstUser = request.messages.findIndex(
    (message) => message.role === "user",
  );
  const messages: HostedChatMessage[] = [];
  for (const [index, message] of request.messages.entries()) {
    if (message.role === "assistant") {
      messages.push({
        role: "assistant",
        content: message.content || null,
        ...(message.toolCalls && message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: {
                  name: call.name,
                  arguments: call.rawArguments,
                },
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
    if (message.role === "system") {
      messages.push({ role: "system", content: message.content });
      continue;
    }
    const content =
      index === firstUser
        ? request.imageCarrier?.carrierProtocol === "zai_mcp_vision"
          ? promptWithZaiVisionToolAttachments(message.content, request.imageManifests)
          : request.imageCarrier?.carrierProtocol === "openai_chat_completions" &&
              (request.imageManifests?.length ?? 0) > 0
            ? await serializeOpenAIChatVisualContent({
                text: message.content,
                manifests: request.imageManifests ?? [],
                payloadPort: request.verifiedImagePayloadPort ?? {
                  read: async () => {
                    throw new Error("verified_image_payload_port_missing");
                  },
                },
              })
          : promptTextForHosted({
              prompt: message.content,
              attachments: [...(request.attachments ?? [])],
            })
        : message.content;
    messages.push({ role: "user", content });
  }
  if (request.instructions?.trim()) {
    return [
      { role: "system", content: request.instructions.trim() },
      ...messages,
    ];
  }
  return messages;
}

function promptWithZaiVisionToolAttachments(
  prompt: string,
  manifests: ModelRoundRequest["imageManifests"],
): string {
  const files = (manifests ?? []).map((manifest) =>
    `- file_id=${manifest.fileId} (${manifest.derivativeMimeType}, ${manifest.width}x${manifest.height})`,
  );
  if (files.length === 0) return prompt;
  return [
    prompt,
    "",
    "Attached images are available only through the admitted Z.AI Vision MCP tool.",
    "Call analyze_attached_image with one exact file_id below and a focused prompt before answering visual questions. Do not invent paths or send native image parts.",
    ...files,
  ].join("\n");
}

export function recordHostedOpenAICompatibleUsage(input: {
  config: HostedRuntimeConfig;
  options: Pick<
    PromptOptions,
    "usageAttribution" | "cacheScope" | "butlerData" | "reasoningEffort"
  >;
  response: Record<string, any>;
  roundIndex: number;
}): void {
  const usageResponse = input.response as unknown as OpenAIResponse;
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
  afterAttributedModelResponse({
    attribution: input.options.usageAttribution,
    model: input.config.modelRef,
    response: usageResponse,
    roundIndex: input.roundIndex,
  });
}
