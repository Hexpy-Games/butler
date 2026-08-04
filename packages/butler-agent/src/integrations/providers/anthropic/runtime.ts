import {
  anthropicMessagesUrl,
  hostedProviderErrorLabel,
  promptTextForHosted,
} from "../shared/hosted-openai-compatible.ts";
import {
  abortError,
  createProviderRequestAttributor,
  numberOrNull,
  sanitizeResponseFinalAnswerText,
  withModelApiRetry,
  type ProviderUsageSample,
} from "../shared/runtime-support.ts";
import {
  providerEmptyResponseError,
  providerHttpError,
  providerNetworkError,
  providerRoundTimeoutError,
  safeEndpointLabel,
} from "../provider-errors.ts";
import type { FunctionToolDefinition, PromptOptions } from "../runtime-contracts.ts";
import type { HostedRuntimeConfig } from "../shared/model-routing.ts";
import { admitSerializedProviderRequest } from "../shared/request-context-admission.ts";
import {
  runGuardedProviderRound,
  type ProviderRoundPolicy,
} from "../shared/provider-round-guard.ts";

export async function createAnthropicMessage(
  config: HostedRuntimeConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  budgetContext?: { attribution?: PromptOptions["usageAttribution"]; roundIndex: number },
  providerRoundPolicy?: Partial<ProviderRoundPolicy>,
): Promise<Record<string, any>> {
  return await runGuardedProviderRound({
    signal,
    policy: providerRoundPolicy,
    operation: async (guardedSignal) => await withModelApiRetry(
      async () => await createAnthropicMessageOnce(config, body, guardedSignal, budgetContext),
      guardedSignal,
    ),
    timeoutError: (timeoutKind) => providerRoundTimeoutError({
      provider: hostedProviderErrorLabel(config),
      api: "messages",
      timeoutKind,
      model: config.modelId,
    }),
    externalAbortError: abortError,
  });
}

async function createAnthropicMessageOnce(
  config: HostedRuntimeConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  budgetContext?: { attribution?: PromptOptions["usageAttribution"]; roundIndex: number },
): Promise<Record<string, any>> {
  const endpoint = safeEndpointLabel(anthropicMessagesUrl(config));
  const requestBody = {
    model: config.modelId,
    max_tokens: budgetContext?.attribution?.requestedOutputTokens ?? 4096,
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
    response = await fetch(anthropicMessagesUrl(config), {
      method: "POST",
      headers: {
        "x-api-key": config.apiKey ?? "",
        "anthropic-version": process.env.BUTLER_ANTHROPIC_VERSION?.trim() || "2023-06-01",
        "Content-Type": "application/json",
      },
      body: admittedRequest.serialized_request,
      signal,
    });
  } catch (error) {
    throw providerNetworkError({
      provider: hostedProviderErrorLabel(config),
      api: "messages",
      endpoint,
      model: config.modelId,
      error,
    });
  }
  const raw = await response.text();
  let parsed: Record<string, any> = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {}
  if (!response.ok) {
    throw providerHttpError({
      provider: hostedProviderErrorLabel(config),
      api: "messages",
      statusCode: response.status,
      detail: parsed?.error?.message || raw || `status ${response.status}`,
      endpoint,
      model: config.modelId,
      admission: admittedRequest,
    });
  }
  return parsed;
}

export function anthropicText(response: Record<string, any>): string {
  return sanitizeResponseFinalAnswerText(
    (Array.isArray(response.content) ? response.content : [])
      .map((part: any) => part?.type === "text" && typeof part.text === "string" ? part.text : "")
      .filter(Boolean)
      .join("\n"),
  );
}

export function anthropicUsageSample(
  response: Record<string, any>,
): ProviderUsageSample | null {
  const uncachedTokens = numberOrNull(response.usage?.input_tokens);
  const cachedTokens = numberOrNull(response.usage?.cache_read_input_tokens) ?? 0;
  const cacheCreationTokens = numberOrNull(response.usage?.cache_creation_input_tokens) ?? 0;
  const promptTokens = uncachedTokens === null
    ? null
    : uncachedTokens + cachedTokens + cacheCreationTokens;
  const outputTokens = numberOrNull(response.usage?.output_tokens) ?? 0;
  const totalTokens = promptTokens === null ? null : promptTokens + outputTokens;
  if (promptTokens === null && totalTokens === null) return null;
  return { promptTokens, cachedTokens, outputTokens, totalTokens };
}

export function anthropicTools(tools: FunctionToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

export async function runAnthropicPromptText(
  config: HostedRuntimeConfig,
  options: PromptOptions,
): Promise<string> {
  const requests = createProviderRequestAttributor({
    attribution: options.usageAttribution,
    butlerData: options.butlerData,
    cacheScope: options.cacheScope,
  });
  const response = await requests.request({
    model: config.modelRef,
    run: async (context) => await createAnthropicMessage(config, {
      ...(options.instructions?.trim() ? { system: options.instructions.trim() } : {}),
      messages: [{ role: "user", content: promptTextForHosted(options) }],
    }, options.signal, context),
    usage: anthropicUsageSample,
  });
  const text = anthropicText(response);
  if (!text) {
    throw providerEmptyResponseError({
      provider: hostedProviderErrorLabel(config),
      api: "messages",
      endpoint: safeEndpointLabel(anthropicMessagesUrl(config)),
      model: config.modelId,
    });
  }
  return text;
}
