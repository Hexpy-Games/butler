import type { FunctionToolDefinition, PromptOptions, ReasoningEffort } from "../runtime-contracts.ts";
import type { HostedModelProviderId } from "./registered-models.ts";
import type { HostedRuntimeConfig } from "./model-routing.ts";
import { defaultHostedProviderApiBaseUrl, type HostedProviderApiShape } from "../model-catalog.ts";
import {
  abortError,
  normalizeLocalTextToolName,
  sanitizeResponseFinalAnswerText,
  withModelApiRetry,
} from "./runtime-support.ts";
import { promptWithAttachmentContext } from "../../../agent/context/attachment-context.ts";
import { ModelProviderRequestError, providerHttpError, providerNetworkError, providerRoundTimeoutError, safeEndpointLabel } from "../provider-errors.ts";
import { admitSerializedProviderRequest } from "./request-context-admission.ts";
import {
  runGuardedProviderRound,
  type ProviderRoundPolicy,
} from "./provider-round-guard.ts";
import {
  HostedChatStreamProtocolError,
  isHostedChatSseResponse,
  readHostedChatSseResponse,
} from "./hosted-chat-stream.ts";



export type HostedOpenAICompatibleProviderId = "xai" | "qwen" | "kimi" | "zai";



export interface HostedChatToolCall {
  id: string;
  type?: "function";
  function: {
    name: string;
    arguments: unknown;
  };
}



export interface HostedChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: HostedChatToolCall[];
  tool_call_id?: string;
  name?: string;
}



export function promptTextForHosted(options: Pick<PromptOptions, "prompt" | "attachments">): string {
  return promptWithAttachmentContext(options.prompt, options.attachments);
}



export function isHostedOpenAICompatibleProvider(
  providerId: HostedModelProviderId,
): providerId is HostedOpenAICompatibleProviderId {
  return providerId === "xai" || providerId === "qwen" || providerId === "kimi" || providerId === "zai";
}



export function hostedProviderBaseUrlEnvKey(providerId: HostedModelProviderId): string {
  if (providerId === "opencode-go") return "BUTLER_OPENCODE_GO_BASE_URL";
  return `BUTLER_${providerId.toUpperCase()}_BASE_URL`;
}



export function hostedProviderApiBase(config: HostedRuntimeConfig): string {
  if (config.apiBaseUrl) return config.apiBaseUrl.replace(/\/+$/u, "");
  const envKey = hostedProviderBaseUrlEnvKey(config.providerId);
  const fromEnv = process.env[envKey]?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/u, "");
  const defaultBaseUrl = defaultHostedProviderApiBaseUrl(config.providerId);
  if (defaultBaseUrl) return defaultBaseUrl;
  if (config.providerId === "anthropic") return "https://api.anthropic.com/v1";
  if (config.providerId === "google") return "https://generativelanguage.googleapis.com/v1beta";
  return "https://api.openai.com/v1";
}



export function hostedChatCompletionsUrl(config: HostedRuntimeConfig): string {
  const base = hostedProviderApiBase(config);
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

export function hostedResponsesUrl(config: HostedRuntimeConfig): string {
  const base = hostedProviderApiBase(config);
  return base.endsWith("/responses") ? base : `${base}/responses`;
}



export function anthropicMessagesUrl(config: HostedRuntimeConfig): string {
  const base = hostedProviderApiBase(config);
  return base.endsWith("/messages") ? base : `${base}/messages`;
}



export function geminiGenerateContentUrl(config: HostedRuntimeConfig): string {
  const base = hostedProviderApiBase(config);
  if (base.includes(":generateContent")) return base;
  return `${base}/models/${encodeURIComponent(config.modelId)}:generateContent`;
}



export function hostedAuthHeader(config: HostedRuntimeConfig): string {
  if (!config.apiKey) throw new Error(`Provider API key credential is not registered for ${config.modelRef}`);
  return `Bearer ${config.apiKey}`;
}



export function hostedProviderErrorLabel(config: HostedRuntimeConfig): string {
  return config.providerId;
}



export function openCodeGoApiShape(config: HostedRuntimeConfig): HostedProviderApiShape {
  if (config.providerId !== "opencode-go") {
    throw new Error(`OpenCode Go API shape requested for unsupported provider: ${config.providerId}`);
  }
  if (
    config.apiShape === "openai_chat_completions" ||
    config.apiShape === "openai_responses" ||
    config.apiShape === "anthropic_messages"
  ) {
    return config.apiShape;
  }
  throw new Error(`OpenCode Go model is missing a supported API shape: ${config.modelRef}`);
}



export function hostedChatTools(tools: FunctionToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}



export function hostedChatResponseFormat(
  format: PromptOptions["responseFormat"],
): Record<string, unknown> | undefined {
  if (!format) return undefined;
  return {
    type: format.type,
    json_schema: {
      name: format.name,
      schema: format.schema,
      ...(format.strict === undefined ? {} : { strict: format.strict }),
    },
  };
}



export function hostedChatReasoningParams(
  config: HostedRuntimeConfig,
  reasoningEffort?: ReasoningEffort,
): Record<string, unknown> {
  if (!reasoningEffort) return {};
  if (config.providerId === "zai") {
    return reasoningEffort === "none" ? {} : { reasoning_effort: reasoningEffort };
  }
  if (config.providerId === "xai") {
    // xAI's legacy Chat Completions carrier accepts this field; the preferred
    // Responses carrier uses the nested `reasoning` form in its own adapter.
    return reasoningEffort === "none" ? {} : { reasoning_effort: reasoningEffort };
  }
  if (config.providerId === "qwen") {
    return { enable_thinking: reasoningEffort !== "none" };
  }
  if (config.providerId === "kimi") {
    if (config.modelId === "kimi-k3") {
      return reasoningEffort === "none" ? {} : { reasoning_effort: reasoningEffort };
    }
    return { thinking: { type: reasoningEffort === "none" ? "disabled" : "enabled" } };
  }
  return {};
}



export function hostedChatText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return sanitizeResponseFinalAnswerText(content);
  if (!Array.isArray(content)) return "";
  return sanitizeResponseFinalAnswerText(
    content
      .map((part) => typeof part?.text === "string" ? part.text : "")
      .filter(Boolean)
      .join("\n"),
  );
}



export function extractHostedChatToolCalls(message: any, allowedNames?: Set<string>): HostedChatToolCall[] {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return calls.flatMap((call: any): HostedChatToolCall[] => {
    const name = normalizeLocalTextToolName(
      typeof call?.function?.name === "string" ? call.function.name : "",
      allowedNames ?? new Set<string>(),
    );
    if (
      !call ||
      typeof call !== "object" ||
      typeof call.id !== "string" ||
      !call.function ||
      typeof call.function !== "object" ||
      !name
    ) {
      return [];
    }
    return [{
      id: call.id,
      type: "function",
      function: {
        name,
        arguments: call.function.arguments,
      },
    }];
  });
}



export async function createHostedChatCompletion(
  config: HostedRuntimeConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  budgetContext?: { attribution?: PromptOptions["usageAttribution"]; roundIndex: number },
  retryAttempts?: number,
  providerRoundPolicy?: Partial<ProviderRoundPolicy>,
): Promise<Record<string, any>> {
  return await runGuardedProviderRound({
    signal,
    policy: providerRoundPolicy,
    operation: async (guardedSignal, recordProgress) => await withModelApiRetry(
      async () => await createHostedChatCompletionOnce(
        config,
        body,
        guardedSignal,
        budgetContext,
        recordProgress,
      ),
      guardedSignal,
      retryAttempts,
    ),
    timeoutError: (timeoutKind) => providerRoundTimeoutError({
      provider: hostedProviderErrorLabel(config),
      api: "chat_completions",
      timeoutKind,
      model: config.modelId,
    }),
    externalAbortError: abortError,
  });
}



async function createHostedChatCompletionOnce(
  config: HostedRuntimeConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  budgetContext?: { attribution?: PromptOptions["usageAttribution"]; roundIndex: number },
  recordProgress: () => void = () => {},
): Promise<Record<string, any>> {
  const endpoint = safeEndpointLabel(hostedChatCompletionsUrl(config));
  const requestBody: Record<string, unknown> = {
    // Kimi's reasoning models reject an explicit sampling temperature; Qwen
    // requires its thinking controls without unsupported sampling overrides.
    ...(config.providerId === "kimi" || config.providerId === "qwen"
      ? {}
      : { temperature: 0 }),
    model: config.modelId,
    ...(budgetContext?.attribution?.requestedOutputTokens &&
      body.max_tokens === undefined && body.max_completion_tokens === undefined
      ? {
          [config.providerId === "kimi" ? "max_completion_tokens" : "max_tokens"]:
            budgetContext.attribution.requestedOutputTokens,
        }
      : {}),
    ...body,
  };
  const admittedRequest = admitSerializedProviderRequest({
    providerId: config.providerId,
    modelRef: config.modelRef,
    body: requestBody,
    requestedOutputTokens: typeof requestBody.max_tokens === "number"
      ? requestBody.max_tokens
      : undefined,
    usageAttribution: budgetContext?.attribution,
    roundIndex: budgetContext?.roundIndex,
  });
  let response: Response;
  try {
    response = await fetch(hostedChatCompletionsUrl(config), {
      method: "POST",
      headers: {
        Authorization: hostedAuthHeader(config),
        "Content-Type": "application/json",
        ...(requestBody.stream === true ? { Accept: "text/event-stream" } : {}),
      },
      body: admittedRequest.serialized_request,
      signal,
    });
  } catch (error) {
    throw providerNetworkError({
      provider: hostedProviderErrorLabel(config),
      api: "chat_completions",
      endpoint,
      model: config.modelId,
      error,
    });
  }
  if (response.ok && requestBody.stream === true && isHostedChatSseResponse(response)) {
    try {
      return await readHostedChatSseResponse(response, recordProgress);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof HostedChatStreamProtocolError) {
        throw new ModelProviderRequestError({
          code: "provider_protocol_error",
          message: "Model provider returned an invalid Chat Completions stream.",
          provider: hostedProviderErrorLabel(config),
          api: "chat_completions",
          endpoint,
          model: config.modelId,
          retryable: false,
          cause: error.message,
        });
      }
      throw providerNetworkError({
        provider: hostedProviderErrorLabel(config),
        api: "chat_completions",
        endpoint,
        model: config.modelId,
        error,
      });
    }
  }
  const raw = await response.text();
  let parsed: Record<string, any> = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {}
  if (!response.ok) {
    throw providerHttpError({
      provider: hostedProviderErrorLabel(config),
      api: "chat_completions",
      statusCode: response.status,
      detail: parsed?.error?.message || raw || `status ${response.status}`,
      endpoint,
      model: config.modelId,
      admission: admittedRequest,
      headers: response.headers,
    });
  }
  return parsed;
}

export function firstHostedChatMessage(response: Record<string, any>): Record<string, any> {
  const message = response.choices?.[0]?.message;
  return message && typeof message === "object" ? message : {};
}
