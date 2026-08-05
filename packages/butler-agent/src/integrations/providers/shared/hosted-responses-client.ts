import type {
  ModelRoundRequest,
  ModelRoundResult,
} from "../../../agent/btcc/ports/model-round.ts";
import type {
  OpenAIResponse,
  PromptOptions,
  PromptTextResult,
  ReasoningEffort,
} from "../runtime-contracts.ts";
import {
  abortError,
  afterAttributedModelResponse,
  beforeAttributedModelRequest,
  extractResponseText,
  getFunctionCalls,
  modelFacingFunctionTools,
  openAIInputWithAttachments,
  parseToolArguments,
  withModelApiRetry,
} from "./runtime-support.ts";
import type { HostedRuntimeConfig } from "./model-routing.ts";
import {
  hostedAuthHeader,
  hostedProviderErrorLabel,
  hostedResponsesUrl,
} from "./hosted-chat-client.ts";
import {
  providerEmptyResponseError,
  providerHttpError,
  providerNetworkError,
  providerRoundTimeoutError,
  safeEndpointLabel,
} from "../provider-errors.ts";
import { admitSerializedProviderRequest } from "./request-context-admission.ts";
import {
  runGuardedProviderRound,
  type ProviderRoundPolicy,
} from "./provider-round-guard.ts";

/**
 * OpenAI-compatible Responses transport used by xAI and OpenCode Go. It is
 * deliberately separate from the OpenAI Codex client: auth, endpoint, and
 * provider identity stay bound to the admitted hosted config.
 */
export async function createHostedResponse(
  config: HostedRuntimeConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  budgetContext?: { attribution?: PromptOptions["usageAttribution"]; roundIndex: number },
  retryAttempts?: number,
  providerRoundPolicy?: Partial<ProviderRoundPolicy>,
): Promise<OpenAIResponse> {
  return await runGuardedProviderRound({
    signal,
    policy: providerRoundPolicy,
    operation: async (guardedSignal) => await withModelApiRetry(
      async () => await createHostedResponseOnce(
        config,
        body,
        guardedSignal,
        budgetContext,
      ),
      guardedSignal,
      retryAttempts,
    ),
    timeoutError: (timeoutKind) => providerRoundTimeoutError({
      provider: hostedProviderErrorLabel(config),
      api: "responses",
      timeoutKind,
      model: config.modelId,
    }),
    externalAbortError: abortError,
  });
}

async function createHostedResponseOnce(
  config: HostedRuntimeConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  budgetContext?: { attribution?: PromptOptions["usageAttribution"]; roundIndex: number },
): Promise<OpenAIResponse> {
  const endpoint = safeEndpointLabel(hostedResponsesUrl(config));
  const requestBody: Record<string, unknown> = {
    model: config.modelId,
    ...body,
  };
  const admittedRequest = admitSerializedProviderRequest({
    providerId: config.providerId,
    modelRef: config.modelRef,
    body: requestBody,
    requestedOutputTokens: typeof requestBody.max_output_tokens === "number"
      ? requestBody.max_output_tokens
      : undefined,
    usageAttribution: budgetContext?.attribution,
    roundIndex: budgetContext?.roundIndex,
  });
  let response: Response;
  try {
    response = await fetch(hostedResponsesUrl(config), {
      method: "POST",
      headers: {
        Authorization: hostedAuthHeader(config),
        "Content-Type": "application/json",
      },
      body: admittedRequest.serialized_request,
      signal,
    });
  } catch (error) {
    throw providerNetworkError({
      provider: hostedProviderErrorLabel(config),
      api: "responses",
      endpoint,
      model: config.modelId,
      error,
    });
  }
  if (!response.ok) {
    const raw = await response.text();
    let detail = raw;
    try {
      const parsed = JSON.parse(raw);
      detail = parsed?.error?.message || raw;
    } catch {}
    throw providerHttpError({
      provider: hostedProviderErrorLabel(config),
      api: "responses",
      statusCode: response.status,
      detail,
      endpoint,
      model: config.modelId,
      admission: admittedRequest,
    });
  }
  return (await response.json()) as OpenAIResponse;
}

function responseReasoning(reasoningEffort?: ReasoningEffort): Record<string, unknown> {
  if (!reasoningEffort || reasoningEffort === "none") return {};
  return { reasoning: { effort: reasoningEffort } };
}

export async function runHostedResponsesPromptText(
  config: HostedRuntimeConfig,
  options: PromptOptions,
): Promise<PromptTextResult> {
  const roundIndex = options.usageAttribution?.roundIndex ?? 0;
  beforeAttributedModelRequest({ attribution: options.usageAttribution, roundIndex });
  const responseFormat = options.responseFormat
    ? { text: { format: options.responseFormat } }
    : {};
  const response = await createHostedResponse(
    config,
    {
      ...(options.instructions?.trim() ? { instructions: options.instructions.trim() } : {}),
      input: openAIInputWithAttachments(options.prompt, options.attachments),
      ...responseReasoning(options.reasoningEffort),
      ...responseFormat,
    },
    options.signal,
    { attribution: options.usageAttribution, roundIndex },
    options.providerRetryAttempts,
  );
  afterAttributedModelResponse({
    attribution: options.usageAttribution,
    model: config.modelRef,
    response,
    roundIndex,
  });
  const text = extractResponseText(response);
  if (!text) {
    throw providerEmptyResponseError({
      provider: hostedProviderErrorLabel(config),
      api: "responses",
      endpoint: safeEndpointLabel(hostedResponsesUrl(config)),
      model: config.modelId,
    });
  }
  return { text, model: config.modelRef, usage: null };
}

export async function runHostedResponsesModelRound(
  config: HostedRuntimeConfig,
  request: ModelRoundRequest,
): Promise<ModelRoundResult> {
  const roundIndex = request.usageAttribution?.roundIndex ?? 0;
  beforeAttributedModelRequest({ attribution: request.usageAttribution, roundIndex });
  const input = hostedResponsesModelRoundInput(request);
  const response = await createHostedResponse(
    config,
    {
      ...(request.instructions?.trim() ? { instructions: request.instructions.trim() } : {}),
      input,
      ...(request.tools.length > 0 ? { tools: modelFacingFunctionTools(request.tools) } : {}),
      tool_choice: request.toolChoice ?? "auto",
      ...responseReasoning(request.reasoningEffort),
    },
    request.signal,
    { attribution: request.usageAttribution, roundIndex },
    request.providerRetryAttempts,
  );
  const calls = getFunctionCalls(response).map((call) => ({
    id: call.call_id,
    name: call.name,
    arguments: parseToolArguments(call.arguments),
    rawArguments: call.arguments,
  }));
  const text = extractResponseText(response);
  const responseRecord = response as unknown as Record<string, unknown>;
  const reportedModel = typeof responseRecord.model === "string"
    ? String(responseRecord.model).trim()
    : "";
  const providerIdentity = reportedModel
    ? { provider: config.providerId, configuredModel: config.modelRef, reportedModel }
    : undefined;
  if (providerIdentity) request.onProviderResponseIdentity?.(providerIdentity);
  afterAttributedModelResponse({
    attribution: request.usageAttribution,
    model: config.modelRef,
    response,
    roundIndex,
  });
  return {
    ...(text ? { text } : {}),
    toolCalls: calls,
    assistantMessage: {
      role: "assistant",
      content: text,
      toolCalls: calls,
      providerData: response.output,
    },
    usage: null,
    ...(providerIdentity ? { providerIdentity } : {}),
    raw: response,
  };
}

/**
 * Responses carriers are stateless here: every round replays the BTCC-owned
 * message history. Provider output items are therefore part of the next
 * request, not just a normalized assistant text projection. In particular,
 * Responses APIs require a function_call item before its function_call_output
 * item; dropping that protocol item makes a tool continuation invalid.
 */
function hostedResponsesModelRoundInput(
  request: ModelRoundRequest,
): Array<Record<string, unknown>> {
  return request.messages.flatMap((message): Array<Record<string, unknown>> => {
    if (message.role === "system") return [];
    if (message.role === "tool") {
      return [{
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content,
      }];
    }
    if (message.role === "assistant") {
      return responsesAssistantItems(message);
    }
    return [{ role: "user", content: message.content }];
  });
}

function responsesAssistantItems(
  message: ModelRoundRequest["messages"][number],
): Array<Record<string, unknown>> {
  const providerItems = providerResponseItems(message.providerData);
  const providerCallIds = new Set(
    providerItems
      .filter((item) => item.type === "function_call" && typeof item.call_id === "string")
      .map((item) => item.call_id as string),
  );
  const calls = (message.toolCalls ?? [])
    .filter((call) => !providerCallIds.has(call.id))
    .map((call) => ({
      type: "function_call",
      call_id: call.id,
      name: call.name,
      arguments: call.rawArguments,
    }));
  if (providerItems.length > 0 || calls.length > 0) {
    return [
      ...providerItems,
      ...calls,
    ];
  }
  return message.content
    ? [{
        role: "assistant",
        content: [{ type: "output_text", text: message.content }],
      }]
    : [];
}

function providerResponseItems(value: unknown): Array<Record<string, unknown>> {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item): Array<Record<string, unknown>> => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    return [item as Record<string, unknown>];
  });
}
