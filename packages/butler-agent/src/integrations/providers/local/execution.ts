import type { FunctionToolPromptOptions, PromptOptions } from "../runtime-contracts.ts";
import { activeFunctionTools, compactTraceValue, createProviderRequestAttributor, finalEnvelopeRetryInstructions, finalNoToolInstructions, localFunctionToolInstructions, localToolArguments, localUserContentWithAttachments, modelIterationLimitWithinUsageBudget, openAICompatibleUsageSample, throwIfAborted, withoutDynamicTools, writeWorkerTrace, type ProviderRequestAttributor } from "../shared/runtime-support.ts";
import { createLocalChatCompletion, firstLocalAssistantMessage, isLocalContextOverflowError, localCompactEvidenceTools, localToolFallbackInstructions } from "./client.ts";
import { extractLocalChatText, extractLocalFinalEnvelopeText, extractLocalToolCalls, type LocalChatMessage, localChatTools, localChatUrl, localFunctionToolContractRepairPrompt, localReasoningRequestParams, localToolsForRequiredRepair, standaloneLocalFunctionCallNames } from "./protocol.ts";
import { serializeToolResultPayloadForProvider } from "../../../agent/model-tool-loop/index.ts";
import { providerEmptyResponseError, safeEndpointLabel } from "../provider-errors.ts";
import { resolveLocalModelConfig } from "../shared/model-routing.ts";
import type { LocalModelConfig } from "./models.ts";
import { toolBatchCompletedHandoffText } from "../../../agent/turn/tool-batch-handoff.ts";
import {
  blockCapacityObservation,
  blockCapacityToolOutput,
  partitionSemanticToolBatch,
} from "../../../agent/turn/tool-batch-capacity.ts";
import { reviewProviderFinalCandidate } from "../shared/final-candidate-review.ts";



export async function runLocalPromptText(options: PromptOptions): Promise<string> {
  const config = resolveLocalModelConfig(options.model);
  return await runLocalPromptTextWithConfig(
    config,
    options,
    createProviderRequestAttributor({ attribution: options.usageAttribution }),
  );
}

export async function runLocalPromptTextWithConfig(
  config: LocalModelConfig,
  options: PromptOptions,
  requests = createProviderRequestAttributor({ attribution: options.usageAttribution }),
): Promise<string> {
  const messages: LocalChatMessage[] = [];
  if (options.instructions?.trim()) {
    messages.push({ role: "system", content: options.instructions.trim() });
  }
  messages.push({ role: "user", content: localUserContentWithAttachments(options.prompt, options.attachments) });
  const response = await attributedLocalCompletion(config, options, requests, {
    model: config.model_id,
    messages,
    ...localReasoningRequestParams(config),
    stream: false,
  });
  const text = extractLocalChatText(firstLocalAssistantMessage(response));
  if (!text) {
    throw providerEmptyResponseError({
      provider: "local",
      api: "chat_completions",
      endpoint: safeEndpointLabel(localChatUrl(config)),
      model: config.model_id,
      local: true,
    });
  }
  return text;
}



export async function runLocalFunctionToolPromptText(options: FunctionToolPromptOptions): Promise<string> {
  const config = resolveLocalModelConfig(options.model);
  return await runLocalFunctionToolPromptTextWithConfig(
    config,
    options,
    createProviderRequestAttributor({ attribution: options.usageAttribution }),
  );
}

export async function runLocalFunctionToolPromptTextWithConfig(
  config: LocalModelConfig,
  options: FunctionToolPromptOptions,
  requests = createProviderRequestAttributor({ attribution: options.usageAttribution }),
): Promise<string> {
  const log = options.log ?? (() => {});
  const maxRounds = modelIterationLimitWithinUsageBudget(
    options.maxToolRounds ?? 8,
    options.usageAttribution,
  );
  const messages: LocalChatMessage[] = [{ role: "system", content: localFunctionToolInstructions(options.instructions) }];
  messages.push({ role: "user", content: localUserContentWithAttachments(options.prompt, options.attachments) });
  let executedToolCalls = 0;
  let toolContractRepairAttempted = false;
  let requiredToolRepairNames: Set<string> | null = null;

  for (let round = 0; round < maxRounds; round += 1) {
    const activeTools = activeFunctionTools(options);
    const allowedNames = new Set(activeTools.map((tool) => tool.name));
    let response;
    try {
      const requestTools = localToolsForRequiredRepair(activeTools, requiredToolRepairNames);
      response = await attributedLocalCompletion(config, options, requests, {
        model: config.model_id,
        messages,
        tools: localChatTools(requestTools),
        tool_choice: requiredToolRepairNames ? "required" : options.toolChoice ?? "auto",
        ...localReasoningRequestParams(config),
        stream: false,
      });
    } catch (error) {
      if (!isLocalContextOverflowError(error)) throw error;
      if (executedToolCalls > 0) {
        throw error;
      }
      const compactTools = localCompactEvidenceTools(activeTools);
      if (compactTools.length > 0 && compactTools.length < activeTools.length) {
        log("local model tool prompt exceeded context window; retrying with compact evidence tool schemas");
        throwIfAborted(options.signal);
        return await runLocalFunctionToolPromptTextWithConfig(
          config,
          {
            ...withoutDynamicTools(options),
            tools: compactTools,
          },
          requests,
        );
      }
      log("local model tool prompt exceeded context window; retrying without tool schemas");
      throwIfAborted(options.signal);
      return await runLocalPromptTextWithConfig(
        config,
        {
          prompt: options.prompt,
          model: options.model,
          instructions: localToolFallbackInstructions(options.instructions),
          signal: options.signal,
          attachments: options.attachments,
          usageAttribution: options.usageAttribution,
        },
        requests,
      );
    }
    const assistant = firstLocalAssistantMessage(response);
    const text = extractLocalChatText(assistant);
    const toolCalls = extractLocalToolCalls(assistant, allowedNames);
    if (toolCalls.length === 0) {
      if (executedToolCalls > 0) {
        const finalText = extractLocalFinalEnvelopeText(assistant);
        if (finalText) {
          const disposition = await reviewProviderFinalCandidate({ options, text: finalText, roundIndex: round });
          if (disposition.kind === "final") return disposition.text;
          messages.push({ role: "assistant", content: assistant.content ?? finalText });
          messages.push({ role: "user", content: disposition.observation });
          continue;
        }
        log(text
          ? "local model returned post-tool draft; requesting final no-tool synthesis"
          : "local model returned no visible post-tool answer; requesting final no-tool synthesis");
        break;
      }
      if (!text) {
        throw providerEmptyResponseError({
          provider: "local",
          api: "chat_completions",
          endpoint: safeEndpointLabel(localChatUrl(config)),
          model: config.model_id,
          local: true,
        });
      }
      const standaloneToolNames = standaloneLocalFunctionCallNames(text, allowedNames);
      if (standaloneToolNames.length > 0) {
        if (!toolContractRepairAttempted) {
          toolContractRepairAttempted = true;
          requiredToolRepairNames = new Set(standaloneToolNames);
          log("local model wrote a tool call as visible text; requesting required structured tool-call repair");
          messages.push({ role: "user", content: localFunctionToolContractRepairPrompt() });
          continue;
        }
        if (!requiredToolRepairNames) {
          requiredToolRepairNames = new Set(standaloneToolNames);
          log("local model repeated visible tool-call text; forcing required structured tool-call repair");
          messages.push({ role: "user", content: localFunctionToolContractRepairPrompt() });
          continue;
        }
        log("local model repeated visible tool-call text after required repair; failing closed without displaying pseudo-call");
        throw new Error("Local model failed to use the structured tool-call channel after required repair");
      }
      const disposition = await reviewProviderFinalCandidate({ options, text, roundIndex: round });
      if (disposition.kind === "final") return disposition.text;
      messages.push({ role: "assistant", content: assistant.content ?? text });
      messages.push({ role: "user", content: disposition.observation });
      continue;
    }

    requiredToolRepairNames = null;
    writeWorkerTrace((options as { taskDir?: string }).taskDir, "provider.assistant.tool_calls", {
      provider: "local",
      text_chars: text.length,
      tool_count: toolCalls.length,
      tool_names: toolCalls.map((call) => call.function.name),
      executed_tool_calls: executedToolCalls,
    });
    const batch = partitionSemanticToolBatch(toolCalls);
    await options.onAssistantTextBeforeTools?.({
      text,
      toolCalls: batch.executable.map((call) => {
        const args = localToolArguments(call.function.arguments);
        return {
          name: call.function.name,
          args: args.parsed,
        };
      }),
    });

    messages.push({
      role: "assistant",
      content: text || null,
      tool_calls: toolCalls,
    });

    for (const call of batch.executable) {
      const args = localToolArguments(call.function.arguments);
      log(`tool ${call.function.name}: ${args.raw}`);
      writeWorkerTrace((options as { taskDir?: string }).taskDir, "provider.tool.start", {
        provider: "local",
        name: call.function.name,
        args_preview: compactTraceValue(args.parsed),
        raw_args_chars: args.raw.length,
      });
      let payload: Record<string, unknown>;
      try {
        const result = await options.executeTool({
          name: call.function.name,
          args: args.parsed,
          rawArguments: args.raw,
        });
        payload = { ok: true, output: result };
        writeWorkerTrace((options as { taskDir?: string }).taskDir, "provider.tool.finish", {
          provider: "local",
          name: call.function.name,
          ok: true,
          output_preview: compactTraceValue(result),
        });
        executedToolCalls += 1;
      } catch (error) {
        payload = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
        writeWorkerTrace((options as { taskDir?: string }).taskDir, "provider.tool.finish", {
          provider: "local",
          name: call.function.name,
          ok: false,
          error: compactTraceValue(payload.error),
        });
        executedToolCalls += 1;
      }
      const finalText = payload.ok
        ? await options.finalTextFromToolResult?.({
            name: call.function.name,
            args: args.parsed,
            output: payload.output,
          })
        : null;
      if (finalText?.trim()) return finalText.trim();
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: serializeToolResultPayloadForProvider(payload),
      });
    }
    for (const call of batch.deferred) {
      const observation = blockCapacityObservation({
        toolCallId: call.id,
        toolName: call.function.name,
        deferredCount: batch.deferred.length,
        turnId: options.usageAttribution?.turnId,
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: serializeToolResultPayloadForProvider({
          ok: false,
          output: blockCapacityToolOutput(observation),
        }),
      });
    }
  }

  if (options.handoffAfterToolBatch && executedToolCalls > 0) {
    return toolBatchCompletedHandoffText();
  }
  messages.push({
    role: "user",
    content: finalNoToolInstructions(),
  });
  let response = await attributedLocalCompletion(config, options, requests, {
    model: config.model_id,
    messages,
    ...localReasoningRequestParams(config),
    stream: false,
  });
  let text = extractLocalFinalEnvelopeText(firstLocalAssistantMessage(response));
  if (!text) {
    messages.push({
      role: "user",
      content: finalEnvelopeRetryInstructions(),
    });
    response = await attributedLocalCompletion(config, options, requests, {
      model: config.model_id,
      messages,
      ...localReasoningRequestParams(config),
      stream: false,
    });
    text = extractLocalFinalEnvelopeText(firstLocalAssistantMessage(response));
  }
  if (!text) {
    throw providerEmptyResponseError({
      provider: "local",
      api: "chat_completions",
      endpoint: safeEndpointLabel(localChatUrl(config)),
      model: config.model_id,
      local: true,
    });
  }
  return text;
}

function attributedLocalCompletion(
  config: LocalModelConfig,
  options: PromptOptions,
  requests: ProviderRequestAttributor,
  body: Record<string, unknown>,
): Promise<Record<string, any>> {
  return requests.request({
    model: config.model_ref,
    run: async (context) => await createLocalChatCompletion(config, body, options.signal, context),
    usage: openAICompatibleUsageSample,
  });
}
