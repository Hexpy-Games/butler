import type { FunctionToolPromptOptions, PromptOptions } from "../runtime-contracts.ts";
import { activeFunctionTools, compactTraceValue, finalEnvelopeRetryInstructions, finalNoToolInstructions, localFunctionToolInstructions, localToolArguments, localUserContentWithAttachments, modelIterationLimitWithinUsageBudget, throwIfAborted, withoutDynamicTools, writeWorkerTrace } from "../shared/runtime-support.ts";
import { createLocalChatCompletion, firstLocalAssistantMessage, isLocalContextOverflowError, localCompactEvidenceTools, localToolFallbackInstructions } from "./client.ts";
import { extractLocalChatText, extractLocalFinalEnvelopeText, extractLocalToolCalls, type LocalChatMessage, localChatTools, localChatUrl, localFunctionToolContractRepairPrompt, localReasoningRequestParams, localToolsForRequiredRepair, standaloneLocalFunctionCallNames } from "./protocol.ts";
import { localToolResultMessageContent, rebudgetLocalToolMessages, runLocalCompactFinalAnswerText } from "./evidence.ts";
import { providerEmptyResponseError, safeEndpointLabel } from "../provider-errors.ts";
import { resolveLocalModelConfig } from "../shared/model-routing.ts";
import { toolBatchCompletedHandoffText } from "../../../agent/turn/tool-batch-handoff.ts";



export async function runLocalPromptText(options: PromptOptions): Promise<string> {
  const config = resolveLocalModelConfig(options.model);
  const messages: LocalChatMessage[] = [];
  if (options.instructions?.trim()) {
    messages.push({ role: "system", content: options.instructions.trim() });
  }
  messages.push({ role: "user", content: localUserContentWithAttachments(options.prompt, options.attachments) });
  const response = await createLocalChatCompletion(config, {
    model: config.model_id,
    messages,
    ...localReasoningRequestParams(config),
    stream: false,
  }, options.signal);
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
      response = await createLocalChatCompletion(config, {
        model: config.model_id,
        messages,
        tools: localChatTools(requestTools),
        tool_choice: requiredToolRepairNames ? "required" : options.toolChoice ?? "auto",
        ...localReasoningRequestParams(config),
        stream: false,
      }, options.signal);
    } catch (error) {
      if (!isLocalContextOverflowError(error)) throw error;
      if (executedToolCalls > 0) {
        log("local model tool prompt exceeded context window after tool results; synthesizing from compacted tool evidence without more tools");
        throwIfAborted(options.signal);
        break;
      }
      const compactTools = localCompactEvidenceTools(activeTools);
      if (compactTools.length > 0 && compactTools.length < activeTools.length) {
        log("local model tool prompt exceeded context window; retrying with compact evidence tool schemas");
        throwIfAborted(options.signal);
        return await runLocalFunctionToolPromptText({
          ...withoutDynamicTools(options),
          tools: compactTools,
        });
      }
      log("local model tool prompt exceeded context window; retrying without tool schemas");
      throwIfAborted(options.signal);
      return await runLocalPromptText({
        prompt: options.prompt,
        model: options.model,
        instructions: localToolFallbackInstructions(options.instructions),
        signal: options.signal,
        attachments: options.attachments,
      });
    }
    if (executedToolCalls > 0) {
      rebudgetLocalToolMessages({ messages, config, log });
    }
    const assistant = firstLocalAssistantMessage(response);
    const text = extractLocalChatText(assistant);
    const toolCalls = extractLocalToolCalls(assistant, allowedNames);
    if (toolCalls.length === 0) {
      if (executedToolCalls > 0) {
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
      return text;
    }

    requiredToolRepairNames = null;
    writeWorkerTrace((options as { taskDir?: string }).taskDir, "provider.assistant.tool_calls", {
      provider: "local",
      text_chars: text.length,
      tool_count: toolCalls.length,
      tool_names: toolCalls.map((call) => call.function.name),
      executed_tool_calls: executedToolCalls,
    });
    await options.onAssistantTextBeforeTools?.({
      text,
      toolCalls: toolCalls.map((call) => {
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

    for (const call of toolCalls) {
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
        content: localToolResultMessageContent({
          payload,
          toolName: call.function.name,
          config,
          log,
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
  let response;
  try {
    response = await createLocalChatCompletion(config, {
      model: config.model_id,
      messages,
      ...localReasoningRequestParams(config),
      stream: false,
    }, options.signal);
  } catch (error) {
    if (!isLocalContextOverflowError(error)) throw error;
    const compacted = rebudgetLocalToolMessages({ messages, config, log, aggressive: true });
    if (!compacted) throw error;
    log("local model final synthesis exceeded context window; retrying with tighter compacted tool evidence");
    try {
      response = await createLocalChatCompletion(config, {
        model: config.model_id,
        messages,
        ...localReasoningRequestParams(config),
        stream: false,
      }, options.signal);
    } catch (retryError) {
      if (!isLocalContextOverflowError(retryError)) throw retryError;
      return await runLocalCompactFinalAnswerText({ config, options, messages, log });
    }
  }
  let text = extractLocalFinalEnvelopeText(firstLocalAssistantMessage(response));
  if (!text) {
    messages.push({
      role: "user",
      content: finalEnvelopeRetryInstructions(),
    });
    try {
      response = await createLocalChatCompletion(config, {
        model: config.model_id,
        messages,
        ...localReasoningRequestParams(config),
        stream: false,
      }, options.signal);
    } catch (error) {
      if (!isLocalContextOverflowError(error)) throw error;
      const compacted = rebudgetLocalToolMessages({ messages, config, log, aggressive: true });
      if (!compacted) throw error;
      log("local model final envelope retry exceeded context window; retrying with tighter compacted tool evidence");
      try {
        response = await createLocalChatCompletion(config, {
          model: config.model_id,
          messages,
          ...localReasoningRequestParams(config),
          stream: false,
        }, options.signal);
      } catch (retryError) {
        if (!isLocalContextOverflowError(retryError)) throw retryError;
        return await runLocalCompactFinalAnswerText({ config, options, messages, log });
      }
    }
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
