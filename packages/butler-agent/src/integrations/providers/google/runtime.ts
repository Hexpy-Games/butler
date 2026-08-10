import {
  abortError,
  createProviderRequestAttributor,
  numberOrNull,
  sanitizeResponseFinalAnswerText,
  withModelApiRetry,
  type ProviderUsageSample,
} from "../shared/runtime-support.ts";
import { geminiGenerateContentUrl, promptTextForHosted } from "../shared/hosted-openai-compatible.ts";
import {
  providerEmptyResponseError,
  providerHttpError,
  providerNetworkError,
  providerRoundTimeoutError,
  safeEndpointLabel,
} from "../provider-errors.ts";
import type { FunctionToolDefinition, PromptOptions } from "../runtime-contracts.ts";
import type { ReasoningEffort } from "../model-catalog.ts";
import type { HostedRuntimeConfig } from "../shared/model-routing.ts";
import { admitSerializedProviderRequest } from "../shared/request-context-admission.ts";
import {
  runGuardedProviderRound,
  type ProviderRoundPolicy,
} from "../shared/provider-round-guard.ts";

export async function createGeminiContent(
  config: HostedRuntimeConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  budgetContext?: { attribution?: PromptOptions["usageAttribution"]; roundIndex: number },
  providerRoundPolicyOrRetryAttempts?: Partial<ProviderRoundPolicy> | number,
  retryAttempts?: number,
): Promise<Record<string, any>> {
  const providerRoundPolicy = typeof providerRoundPolicyOrRetryAttempts === "number"
    ? undefined
    : providerRoundPolicyOrRetryAttempts;
  const retryOverride = typeof providerRoundPolicyOrRetryAttempts === "number"
    ? providerRoundPolicyOrRetryAttempts
    : retryAttempts;
  return await runGuardedProviderRound({
    signal,
    policy: providerRoundPolicy,
    operation: async (guardedSignal) => await withModelApiRetry(
      async () => await createGeminiContentOnce(config, body, guardedSignal, budgetContext),
      guardedSignal,
      retryOverride,
    ),
    timeoutError: (timeoutKind) => providerRoundTimeoutError({
      provider: "google",
      api: "generate_content",
      timeoutKind,
      model: config.modelId,
    }),
    externalAbortError: abortError,
  });
}

async function createGeminiContentOnce(
  config: HostedRuntimeConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  budgetContext?: { attribution?: PromptOptions["usageAttribution"]; roundIndex: number },
): Promise<Record<string, any>> {
  const endpoint = safeEndpointLabel(geminiGenerateContentUrl(config));
  const requestBody = {
    ...body,
    ...(budgetContext?.attribution?.requestedOutputTokens
      ? {
          generationConfig: {
            ...(body.generationConfig && typeof body.generationConfig === "object"
              ? body.generationConfig as Record<string, unknown>
              : {}),
            maxOutputTokens: budgetContext.attribution.requestedOutputTokens,
          },
        }
      : {}),
  };
  const generationConfig = requestBody.generationConfig && typeof requestBody.generationConfig === "object"
    ? requestBody.generationConfig as Record<string, unknown>
    : null;
  const admittedRequest = admitSerializedProviderRequest({
    providerId: "google",
    modelRef: config.modelRef,
    body: requestBody,
    requestedOutputTokens: typeof generationConfig?.maxOutputTokens === "number"
      ? generationConfig.maxOutputTokens
      : undefined,
    usageAttribution: budgetContext?.attribution,
    roundIndex: budgetContext?.roundIndex,
  });
  let response: Response;
  try {
    response = await fetch(geminiGenerateContentUrl(config), {
      method: "POST",
      headers: {
        "x-goog-api-key": config.apiKey ?? "",
        "Content-Type": "application/json",
      },
      body: admittedRequest.serialized_request,
      signal,
    });
  } catch (error) {
    throw providerNetworkError({
      provider: "google",
      api: "generate_content",
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
      provider: "google",
      api: "generate_content",
      statusCode: response.status,
      detail: parsed?.error?.message || raw || `status ${response.status}`,
      providerError: parsed,
      endpoint,
      model: config.modelId,
      admission: admittedRequest,
      headers: response.headers,
    });
  }
  return parsed;
}

export function geminiText(response: Record<string, any>): string {
  const parts = response.candidates?.[0]?.content?.parts;
  return sanitizeResponseFinalAnswerText(
    (Array.isArray(parts) ? parts : [])
      .map((part: any) => typeof part?.text === "string" ? part.text : "")
      .filter(Boolean)
      .join("\n"),
  );
}

export function geminiUsageSample(
  response: Record<string, any>,
): ProviderUsageSample | null {
  const promptTokens = numberOrNull(response.usageMetadata?.promptTokenCount);
  const providerOutputTokens = numberOrNull(response.usageMetadata?.candidatesTokenCount);
  const outputTokens = providerOutputTokens ?? 0;
  const totalTokens = numberOrNull(response.usageMetadata?.totalTokenCount) ??
    (promptTokens === null ? null : promptTokens + outputTokens);
  const providerCacheReadTokens = numberOrNull(response.usageMetadata?.cachedContentTokenCount);
  const cachedTokens = providerCacheReadTokens ?? 0;
  const providerTotalTokens = numberOrNull(response.usageMetadata?.totalTokenCount);
  if (
    promptTokens === null &&
    totalTokens === null &&
    providerCacheReadTokens === null &&
    providerOutputTokens === null
  ) return null;
  return {
    promptTokens,
    cachedTokens,
    outputTokens,
    totalTokens,
    providerPromptTokens: promptTokens,
    providerCacheReadTokens,
    providerCacheWriteTokens: null,
    providerOutputTokens,
    providerTotalTokens,
  };
}

export function geminiTools(tools: FunctionToolDefinition[]): Array<Record<string, unknown>> {
  return [{
    functionDeclarations: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  }];
}

/** Gemini 3.x exposes thinking through generationConfig.thinkingConfig. */
export function geminiReasoningParams(
  reasoningEffort?: ReasoningEffort,
): Record<string, unknown> {
  if (!reasoningEffort) return {};
  const thinkingLevel = reasoningEffort === "none"
    ? "MINIMAL"
    : reasoningEffort === "low"
      ? "LOW"
      : reasoningEffort === "medium"
        ? "MEDIUM"
        : "HIGH";
  return {
    generationConfig: {
      thinkingConfig: { thinkingLevel },
    },
  };
}

export async function runGeminiPromptText(
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
    run: async (context) => await createGeminiContent(config, {
      ...(options.instructions?.trim()
        ? { systemInstruction: { parts: [{ text: options.instructions.trim() }] } }
        : {}),
      ...geminiReasoningParams(options.reasoningEffort),
      contents: [{ role: "user", parts: [{ text: promptTextForHosted(options) }] }],
    }, options.signal, context, options.providerRetryAttempts),
    usage: geminiUsageSample,
  });
  const text = geminiText(response);
  if (!text) {
    throw providerEmptyResponseError({
      provider: "google",
      api: "generate_content",
      endpoint: safeEndpointLabel(geminiGenerateContentUrl(config)),
      model: config.modelId,
    });
  }
  return text;
}
