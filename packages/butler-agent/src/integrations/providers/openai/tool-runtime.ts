import type { FunctionToolPromptOptions, OpenAIAuthOverride } from "../runtime-contracts.ts";
import { activeFunctionTools, afterAttributedModelResponse, beforeAttributedModelRequest, extractResponseText, finalNoToolInstructions, functionToolToAgentTool, modelIterationLimitWithinUsageBudget, newToolMessages, openAIInputWithAttachments, responseToAgentModelResponse } from "../shared/runtime-support.ts";
import { buildReasoningConfig, getButlerRuntime, resolveOpenAIModel, resolveOpenAIPromptCacheConfig } from "./config.ts";
import { createOpenAIResponse, functionCallContinuationItems, toCodexStatelessInput } from "./responses.ts";
import { logPromptCacheStats, recordPromptCacheMetric } from "./usage.ts";
import { promptWithAttachmentContext } from "../../../agent/context/attachment-context.ts";
import { resolveDynamicOpenAIModel } from "./models.ts";
import { runAgentLoop } from "../../../agent/turn/agent-loop.ts";
import { toolBatchCompletedHandoffText } from "../../../agent/turn/tool-batch-handoff.ts";



export async function runOpenAIFunctionToolPromptText(
  options: FunctionToolPromptOptions,
  authOverride?: OpenAIAuthOverride,
  modelOverride?: string,
): Promise<string> {
  if (getButlerRuntime() !== "codex-api" && !authOverride) {
    throw new Error("runFunctionToolPromptText is only available when BUTLER_RUNTIME=codex-api");
  }
  const resolution = resolveOpenAIModel(modelOverride ?? options.model, options.reasoningEffort);
  const model = await resolveDynamicOpenAIModel(resolution.model);
  const reasoning = buildReasoningConfig(resolution);
  const log = options.log ?? (() => {});
  const promptCache = resolveOpenAIPromptCacheConfig(options.cacheScope ?? "function-tool-prompt");
  const maxRounds = modelIterationLimitWithinUsageBudget(
    options.maxToolRounds ?? 8,
    options.usageAttribution,
  );
  let previousResponseId: string | null = null;
  let sentToolMessages = 0;
  const initialPromptInput = openAIInputWithAttachments(options.prompt, options.attachments);
  const promptForAgentLoop = promptWithAttachmentContext(options.prompt, options.attachments);
  const codexStatelessInput = toCodexStatelessInput(initialPromptInput);
  let modelCallRound = 0;
  const agentLoopTools = activeFunctionTools(options).map(functionToolToAgentTool);

  const result = await runAgentLoop({
    messages: [{ role: "user", content: promptForAgentLoop }],
    tools: agentLoopTools,
    maxIterations: maxRounds,
    compactToolResultsBeforeNextModelCall: true,
    evidenceRetention: {
      butlerData: options.butlerData,
      turnId: options.usageAttribution?.turnId,
    },
    callModel: async ({ messages }) => {
      const activeTools = activeFunctionTools(options);
      const allowedNames = new Set(activeTools.map((tool) => tool.name));
      agentLoopTools.splice(0, agentLoopTools.length, ...activeTools.map(functionToolToAgentTool));
      const input = previousResponseId
        ? newToolMessages(messages, sentToolMessages)
        : { items: initialPromptInput, sentCount: sentToolMessages };
      sentToolMessages = input.sentCount;
      if (previousResponseId && Array.isArray(input.items)) {
        codexStatelessInput.push(...input.items);
      }

      beforeAttributedModelRequest({
        attribution: options.usageAttribution,
        roundIndex: modelCallRound,
      });
      const response = await createOpenAIResponse({
        model,
        store: true,
        ...promptCache,
        instructions: options.instructions,
        tools: activeTools,
        tool_choice: options.toolChoice ?? "auto",
        reasoning,
        ...(previousResponseId
          ? {
              previous_response_id: previousResponseId,
              input: input.items,
              __butler_codex_stateless_input: codexStatelessInput,
            }
          : {
              input: input.items,
              __butler_codex_stateless_input: codexStatelessInput,
            }),
      }, options.signal, authOverride, options.onProviderStreamEvent);
      afterAttributedModelResponse({
        attribution: options.usageAttribution,
        model,
        response,
        roundIndex: modelCallRound,
      });
      previousResponseId = response.id;
      const functionCallItems = functionCallContinuationItems(response, allowedNames);
      if (functionCallItems.length > 0) {
        codexStatelessInput.push(...functionCallItems);
      }
      recordPromptCacheMetric(response, {
        model,
        scope: options.cacheScope ?? "function-tool-prompt",
        promptCache,
        butlerData: options.butlerData,
        usageAttribution: {
          ...options.usageAttribution,
          reasoningEffort: resolution.reasoningEffort,
          roundIndex: modelCallRound,
        },
      });
      modelCallRound += 1;
      logPromptCacheStats(response, log, promptCache);
      return responseToAgentModelResponse(response, allowedNames);
    },
    executeTool: async (call) => {
      log(`tool ${call.name}: ${JSON.stringify(call.arguments)}`);
      return await options.executeTool({
        name: call.name,
        args: call.arguments,
        rawArguments: JSON.stringify(call.arguments),
      });
    },
    finalTextFromToolResult: async ({ toolCall, toolResult }) =>
      await options.finalTextFromToolResult?.({
        name: toolCall.name,
        args: toolCall.arguments,
        output: toolResult.output,
      }),
    onAssistantTextBeforeTools: async ({ text, toolCalls }) => {
      await options.onAssistantTextBeforeTools?.({
        text,
        toolCalls: toolCalls.map((call) => ({
          name: call.name,
          args: call.arguments,
        })),
      });
    },
    onLoopLimit: async ({ messages }) => {
      if (options.handoffAfterToolBatch) {
        return toolBatchCompletedHandoffText();
      }
      if (!previousResponseId) return "";
      const pending = newToolMessages(messages, sentToolMessages);
      if (pending.items.length === 0) return "";
      sentToolMessages = pending.sentCount;
      codexStatelessInput.push(...pending.items);
      try {
        beforeAttributedModelRequest({
          attribution: options.usageAttribution,
          roundIndex: modelCallRound,
        });
        const response = await createOpenAIResponse({
          model,
          store: true,
          ...promptCache,
          instructions: finalNoToolInstructions(options.instructions),
          reasoning,
          previous_response_id: previousResponseId,
          input: pending.items,
          __butler_codex_stateless_input: codexStatelessInput,
        }, options.signal, authOverride, options.onProviderStreamEvent);
        afterAttributedModelResponse({
          attribution: options.usageAttribution,
          model,
          response,
          roundIndex: modelCallRound,
        });
        previousResponseId = response.id;
        recordPromptCacheMetric(response, {
          model,
          scope: options.cacheScope ?? "function-tool-prompt",
          promptCache,
          butlerData: options.butlerData,
          usageAttribution: {
            ...options.usageAttribution,
            reasoningEffort: resolution.reasoningEffort,
            roundIndex: modelCallRound,
          },
        });
        modelCallRound += 1;
        logPromptCacheStats(response, log, promptCache);
        return extractResponseText(response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`final no-tool synthesis failed; using safe fallback: ${message}`);
        return "";
      }
    },
  });

  if (!result.finalText.trim()) {
    throw new Error("Runtime finished without a text result");
  }
  return result.finalText;
}
