import { anthropicMessagesUrl, hostedProviderErrorLabel, promptTextForHosted } from "../shared/hosted-openai-compatible.ts";
import { activeFunctionTools, createProviderRequestAttributor, finalNoToolInstructions, localFunctionToolInstructions, localToolArguments, modelIterationLimitWithinUsageBudget, normalizeLocalTextToolName, numberOrNull, sanitizeResponseFinalAnswerText, withModelApiRetry, type ProviderUsageSample } from "../shared/runtime-support.ts";
import { providerEmptyResponseError, providerHttpError, providerNetworkError, safeEndpointLabel } from "../provider-errors.ts";
import { toolBatchCompletedHandoffText } from "../../../agent/turn/tool-batch-handoff.ts";
import { type FunctionToolDefinition, type FunctionToolPromptOptions, type PromptOptions } from "../runtime-contracts.ts";
import { type HostedRuntimeConfig } from "../shared/model-routing.ts";
import {
  blockCapacityObservation,
  blockCapacityToolOutput,
  partitionSemanticToolBatch,
} from "../../../agent/turn/tool-batch-capacity.ts";
import { reviewProviderFinalCandidate } from "../shared/final-candidate-review.ts";


export async function createAnthropicMessage(
  config: HostedRuntimeConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, any>> {
  return await withModelApiRetry(
    async () => await createAnthropicMessageOnce(config, body, signal),
    signal,
  );
}


async function createAnthropicMessageOnce(
  config: HostedRuntimeConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, any>> {
  const endpoint = safeEndpointLabel(anthropicMessagesUrl(config));
  let response: Response;
  try {
    response = await fetch(anthropicMessagesUrl(config), {
      method: "POST",
      headers: {
        "x-api-key": config.apiKey ?? "",
        "anthropic-version": process.env.BUTLER_ANTHROPIC_VERSION?.trim() || "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.modelId,
        max_tokens: 4096,
        ...body,
      }),
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
  const requests = createProviderRequestAttributor({ attribution: options.usageAttribution });
  const response = await requests.request({
    model: config.modelRef,
    run: async () => await createAnthropicMessage(config, {
      ...(options.instructions?.trim() ? { system: options.instructions.trim() } : {}),
      messages: [{ role: "user", content: promptTextForHosted(options) }],
    }, options.signal),
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


export async function runAnthropicFunctionToolPromptText(
  config: HostedRuntimeConfig,
  options: FunctionToolPromptOptions,
): Promise<string> {
  const log = options.log ?? (() => {});
  const maxRounds = modelIterationLimitWithinUsageBudget(
    options.maxToolRounds ?? 8,
    options.usageAttribution,
  );
  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: promptTextForHosted(options) },
  ];
  const requests = createProviderRequestAttributor({ attribution: options.usageAttribution });
  let toolBatchExecuted = false;
  for (let round = 0; round < maxRounds; round += 1) {
    const activeTools = activeFunctionTools(options);
    const allowedNames = new Set(activeTools.map((tool) => tool.name));
    const response = await requests.request({
      model: config.modelRef,
      run: async () => await createAnthropicMessage(config, {
        system: localFunctionToolInstructions(options.instructions),
        messages,
        tools: anthropicTools(activeTools),
        ...(options.toolChoice === "required" ? { tool_choice: { type: "any" } } : {}),
      }, options.signal),
      usage: anthropicUsageSample,
    });
    const content = Array.isArray(response.content) ? response.content : [];
    const text = anthropicText(response);
    const toolUses = content.flatMap((part: any) => {
      const name = normalizeLocalTextToolName(typeof part?.name === "string" ? part.name : "", allowedNames);
      if (part?.type !== "tool_use" || typeof part.id !== "string" || !name) return [];
      return [{ id: part.id as string, name, input: localToolArguments(part.input).parsed }];
    });
    if (toolUses.length === 0) {
      if (text) {
        const disposition = await reviewProviderFinalCandidate({ options, text, roundIndex: round });
        if (disposition.kind === "final") return disposition.text;
        messages.push({ role: "assistant", content });
        messages.push({ role: "user", content: disposition.observation });
        continue;
      }
      throw providerEmptyResponseError({
        provider: hostedProviderErrorLabel(config),
        api: "messages",
        endpoint: safeEndpointLabel(anthropicMessagesUrl(config)),
        model: config.modelId,
      });
    }
    const batch = partitionSemanticToolBatch(toolUses);
    await options.onAssistantTextBeforeTools?.({
      text,
      toolCalls: batch.executable.map((call) => ({ name: call.name, args: call.input })),
    });
    messages.push({ role: "assistant", content });
    toolBatchExecuted = true;
    for (const call of batch.executable) {
      const rawArguments = JSON.stringify(call.input);
      log(`tool ${call.name}: ${rawArguments}`);
      let payload: Record<string, unknown>;
      try {
        payload = {
          ok: true,
          output: await options.executeTool({
            name: call.name,
            args: call.input,
            rawArguments,
          }),
        };
      } catch (error) {
        payload = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      const finalText = payload.ok
        ? await options.finalTextFromToolResult?.({
            name: call.name,
            args: call.input,
            output: payload.output,
          })
        : null;
      if (finalText?.trim()) return finalText.trim();
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: call.id,
          content: JSON.stringify(payload),
        }],
      });
    }
    for (const call of batch.deferred) {
      const observation = blockCapacityObservation({
        toolCallId: call.id,
        toolName: call.name,
        deferredCount: batch.deferred.length,
        turnId: options.usageAttribution?.turnId,
      });
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: call.id,
          content: JSON.stringify({ ok: false, output: blockCapacityToolOutput(observation) }),
        }],
      });
    }
  }
  if (options.handoffAfterToolBatch && toolBatchExecuted) {
    return toolBatchCompletedHandoffText();
  }
  messages.push({ role: "user", content: finalNoToolInstructions(options.instructions) });
  const response = await requests.request({
    model: config.modelRef,
    run: async () => await createAnthropicMessage(config, {
      system: finalNoToolInstructions(options.instructions),
      messages,
    }, options.signal),
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
