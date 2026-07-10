import { anthropicMessagesUrl, hostedProviderErrorLabel, promptTextForHosted } from "../shared/hosted-openai-compatible.ts";
import { finalNoToolInstructions, localFunctionToolInstructions, localToolArguments, modelIterationLimitWithinUsageBudget, normalizeLocalTextToolName, sanitizeResponseFinalAnswerText } from "../shared/runtime-support.ts";
import { providerEmptyResponseError, providerHttpError, providerNetworkError, safeEndpointLabel } from "../provider-errors.ts";
import { toolBatchCompletedHandoffText } from "../../../agent/turn/tool-batch-handoff.ts";
import { type FunctionToolDefinition, type FunctionToolPromptOptions, type PromptOptions } from "../runtime-contracts.ts";
import { type HostedRuntimeConfig } from "../shared/model-routing.ts";


export async function createAnthropicMessage(
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
  const response = await createAnthropicMessage(config, {
    ...(options.instructions?.trim() ? { system: options.instructions.trim() } : {}),
    messages: [{ role: "user", content: promptTextForHosted(options) }],
  }, options.signal);
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
  const allowedNames = new Set(options.tools.map((tool) => tool.name));
  const maxRounds = modelIterationLimitWithinUsageBudget(
    options.maxToolRounds ?? 8,
    options.usageAttribution,
  );
  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: promptTextForHosted(options) },
  ];
  let toolBatchExecuted = false;
  for (let round = 0; round < maxRounds; round += 1) {
    const response = await createAnthropicMessage(config, {
      system: localFunctionToolInstructions(options.instructions),
      messages,
      tools: anthropicTools(options.tools),
      ...(options.toolChoice === "required" ? { tool_choice: { type: "any" } } : {}),
    }, options.signal);
    const content = Array.isArray(response.content) ? response.content : [];
    const text = anthropicText(response);
    const toolUses = content.flatMap((part: any) => {
      const name = normalizeLocalTextToolName(typeof part?.name === "string" ? part.name : "", allowedNames);
      if (part?.type !== "tool_use" || typeof part.id !== "string" || !name) return [];
      return [{ id: part.id as string, name, input: localToolArguments(part.input).parsed }];
    });
    if (toolUses.length === 0) {
      if (text) return text;
      throw providerEmptyResponseError({
        provider: hostedProviderErrorLabel(config),
        api: "messages",
        endpoint: safeEndpointLabel(anthropicMessagesUrl(config)),
        model: config.modelId,
      });
    }
    await options.onAssistantTextBeforeTools?.({
      text,
      toolCalls: toolUses.map((call) => ({ name: call.name, args: call.input })),
    });
    messages.push({ role: "assistant", content });
    toolBatchExecuted = true;
    for (const call of toolUses) {
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
  }
  if (options.handoffAfterToolBatch && toolBatchExecuted) {
    return toolBatchCompletedHandoffText();
  }
  messages.push({ role: "user", content: finalNoToolInstructions(options.instructions) });
  const response = await createAnthropicMessage(config, {
    system: finalNoToolInstructions(options.instructions),
    messages,
  }, options.signal);
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
