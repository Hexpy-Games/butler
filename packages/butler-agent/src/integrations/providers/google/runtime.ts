import { abortError, activeFunctionTools, createProviderRequestAttributor, finalNoToolInstructions, localFunctionToolInstructions, localToolArguments, modelIterationLimitWithinUsageBudget, normalizeLocalTextToolName, numberOrNull, sanitizeResponseFinalAnswerText, unavailableFunctionToolPayload, withModelApiRetry, type ProviderUsageSample } from "../shared/runtime-support.ts";
import { geminiGenerateContentUrl, promptTextForHosted } from "../shared/hosted-openai-compatible.ts";
import { providerEmptyResponseError, providerHttpError, providerNetworkError, providerRoundTimeoutError, safeEndpointLabel } from "../provider-errors.ts";
import { toolBatchCompletedHandoffText } from "../../../agent/model-tool-loop/index.ts";
import { type FunctionToolDefinition, type FunctionToolPromptOptions, type PromptOptions } from "../runtime-contracts.ts";
import { type HostedRuntimeConfig } from "../shared/model-routing.ts";
import {
  blockCapacityObservation,
  blockCapacityToolOutput,
  partitionSemanticToolBatch,
} from "../../../agent/model-tool-loop/index.ts";
import { reviewProviderFinalCandidate } from "../shared/final-candidate-review.ts";
import { admitSerializedProviderRequest } from "../shared/request-context-admission.ts";
import { toolResultPayloadForProvider } from "../../../agent/model-tool-loop/index.ts";
import { runGuardedProviderRound, type ProviderRoundPolicy } from "../shared/provider-round-guard.ts";


export async function createGeminiContent(
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
      async () => await createGeminiContentOnce(config, body, guardedSignal, budgetContext),
      guardedSignal,
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
      endpoint,
      model: config.modelId,
      admission: admittedRequest,
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
  const outputTokens = numberOrNull(response.usageMetadata?.candidatesTokenCount) ?? 0;
  const totalTokens = numberOrNull(response.usageMetadata?.totalTokenCount) ??
    (promptTokens === null ? null : promptTokens + outputTokens);
  const cachedTokens = numberOrNull(response.usageMetadata?.cachedContentTokenCount) ?? 0;
  if (promptTokens === null && totalTokens === null) return null;
  return { promptTokens, cachedTokens, outputTokens, totalTokens };
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


export async function runGeminiPromptText(
  config: HostedRuntimeConfig,
  options: PromptOptions,
): Promise<string> {
  const requests = createProviderRequestAttributor({ attribution: options.usageAttribution });
  const response = await requests.request({
    model: config.modelRef,
    run: async (context) => await createGeminiContent(config, {
      ...(options.instructions?.trim()
        ? { systemInstruction: { parts: [{ text: options.instructions.trim() }] } }
        : {}),
      contents: [{ role: "user", parts: [{ text: promptTextForHosted(options) }] }],
    }, options.signal, context),
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


export async function runGeminiFunctionToolPromptText(
  config: HostedRuntimeConfig,
  options: FunctionToolPromptOptions,
): Promise<string> {
  const log = options.log ?? (() => {});
  const maxRounds = modelIterationLimitWithinUsageBudget(
    options.maxToolRounds ?? 8,
    options.usageAttribution,
  );
  const contents: Array<Record<string, unknown>> = [
    { role: "user", parts: [{ text: promptTextForHosted(options) }] },
  ];
  const requests = createProviderRequestAttributor({ attribution: options.usageAttribution });
  let toolBatchExecuted = false;
  for (let round = 0; round < maxRounds; round += 1) {
    const activeTools = activeFunctionTools(options);
    const allowedNames = new Set(activeTools.map((tool) => tool.name));
    const response = await requests.request({
      model: config.modelRef,
      run: async (context) => await createGeminiContent(config, {
        systemInstruction: { parts: [{ text: localFunctionToolInstructions(options.instructions) }] },
        contents,
        tools: geminiTools(activeTools),
        ...(options.toolChoice === "required"
          ? { toolConfig: { functionCallingConfig: { mode: "ANY" } } }
          : {}),
      }, options.signal, context),
      usage: geminiUsageSample,
    });
    const parts = response.candidates?.[0]?.content?.parts;
    const responseParts = Array.isArray(parts) ? parts : [];
    const text = geminiText(response);
    const calls = responseParts.flatMap((part: any) => {
      const functionCall = part?.functionCall;
      const name = normalizeLocalTextToolName(
        typeof functionCall?.name === "string" ? functionCall.name : "",
        allowedNames,
      );
      if (!name) return [];
      const args = localToolArguments(functionCall.args ?? {});
      return [{ id: `gemini_call_${round}_${name}`, name, args: args.parsed, raw: args.raw }];
    });
    if (calls.length === 0) {
      if (text) {
        const disposition = await reviewProviderFinalCandidate({ options, text, roundIndex: round });
        if (disposition.kind === "final") return disposition.text;
        contents.push({ role: "model", parts: responseParts });
        contents.push({ role: "user", parts: [{ text: disposition.observation }] });
        continue;
      }
      throw providerEmptyResponseError({
        provider: "google",
        api: "generate_content",
        endpoint: safeEndpointLabel(geminiGenerateContentUrl(config)),
        model: config.modelId,
      });
    }
    const batch = partitionSemanticToolBatch(calls);
    await options.onAssistantTextBeforeTools?.({
      text,
      toolCalls: batch.executable.map((call) => ({ name: call.name, args: call.args })),
    });
    contents.push({ role: "model", parts: responseParts });
    toolBatchExecuted = true;
    for (const call of batch.executable) {
      log(`tool ${call.name}: ${call.raw}`);
      let payload = unavailableFunctionToolPayload({
        name: call.name,
        args: call.args,
        allowedNames,
      });
      if (!payload) {
        try {
          payload = {
            ok: true,
            output: await options.executeTool({
              name: call.name,
              args: call.args,
              rawArguments: call.raw,
              signal: options.signal,
            }),
          };
        } catch (error) {
          payload = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      const finalText = payload.ok
        ? await options.finalTextFromToolResult?.({
            name: call.name,
            args: call.args,
            output: payload.output,
          })
        : null;
      if (finalText?.trim()) return finalText.trim();
      contents.push({
        role: "user",
        parts: [{
          functionResponse: {
            name: call.name,
            response: toolResultPayloadForProvider(payload),
          },
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
      contents.push({
        role: "user",
        parts: [{
          functionResponse: {
            name: call.name,
            response: toolResultPayloadForProvider({
              ok: false,
              output: blockCapacityToolOutput(observation),
            }),
          },
        }],
      });
    }
  }
  if (options.handoffAfterToolBatch && toolBatchExecuted) {
    return toolBatchCompletedHandoffText();
  }
  contents.push({ role: "user", parts: [{ text: finalNoToolInstructions(options.instructions) }] });
  const response = await requests.request({
    model: config.modelRef,
    run: async (context) => await createGeminiContent(config, {
      systemInstruction: { parts: [{ text: localFunctionToolInstructions(options.instructions) }] },
      contents,
    }, options.signal, context),
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
