import type { FunctionToolPromptOptions, OpenAIAuthOverride } from "../runtime-contracts.ts";
import { activeFunctionTools, afterAttributedModelResponse, beforeAttributedModelRequest, extractResponseText, finalNoToolInstructions, functionToolToAgentTool, modelFacingFunctionTools, modelIterationLimitWithinUsageBudget, newAgentLoopContinuationMessages, openAIInputWithAttachments, responseToAgentModelResponse } from "../shared/runtime-support.ts";
import { buildReasoningConfig, getButlerRuntime, resolveOpenAIModel, resolveOpenAIPromptCacheConfig } from "./config.ts";
import { createOpenAIResponse, functionCallContinuationItems, toCodexStatelessInput } from "./responses.ts";
import { logPromptCacheStats, recordPromptCacheMetric } from "./usage.ts";
import { promptWithAttachmentContext } from "../../../agent/context/attachment-context.ts";
import { resolveDynamicOpenAIModel } from "./models.ts";
import { runAgentLoop } from "../../../agent/model-tool-loop/index.ts";
import { toolBatchCompletedHandoffText } from "../../../agent/model-tool-loop/index.ts";
import { reviewProviderFinalCandidate } from "../shared/final-candidate-review.ts";



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
  let sentContinuation = { toolMessages: 0, userMessages: 1 };
  const initialPromptInput = openAIInputWithAttachments(options.prompt, options.attachments);
  const promptForAgentLoop = promptWithAttachmentContext(options.prompt, options.attachments);
  const codexStatelessInput = toCodexStatelessInput(initialPromptInput);
  let modelCallRound = 0;
  const agentLoopTools = activeFunctionTools(options).map(functionToolToAgentTool);

  const result = await runAgentLoop({
    messages: [{ role: "user", content: promptForAgentLoop }],
    tools: agentLoopTools,
    maxIterations: maxRounds,
    callModel: async ({ messages }) => {
      const activeTools = activeFunctionTools(options);
      agentLoopTools.splice(0, agentLoopTools.length, ...activeTools.map(functionToolToAgentTool));
      const continuation = previousResponseId
        ? newAgentLoopContinuationMessages(
            messages,
            sentContinuation,
            options.butlerData,
          )
        : null;
      const requestItems = continuation?.items ?? initialPromptInput;
      const statelessRequestInput = continuation
        ? [...codexStatelessInput, ...continuation.items]
        : codexStatelessInput;

      beforeAttributedModelRequest({
        attribution: options.usageAttribution,
        roundIndex: modelCallRound,
      });
      const response = await createOpenAIResponse({
        model,
        store: true,
        ...promptCache,
        instructions: options.instructions,
        tools: modelFacingFunctionTools(activeTools),
        tool_choice: options.toolChoice ?? "auto",
        reasoning,
        ...(previousResponseId
          ? {
              previous_response_id: previousResponseId,
              input: requestItems,
              __butler_codex_stateless_input: statelessRequestInput,
            }
          : {
              input: requestItems,
              __butler_codex_stateless_input: codexStatelessInput,
            }),
      }, options.signal, authOverride, options.onProviderStreamEvent, {
        attribution: options.usageAttribution,
        roundIndex: modelCallRound,
      }, undefined, options.providerRetryAttempts);
      afterAttributedModelResponse({
        attribution: options.usageAttribution,
        model,
        response,
        roundIndex: modelCallRound,
      });
      if (continuation) {
        sentContinuation = continuation.sent;
        codexStatelessInput.push(...continuation.statelessItems);
      }
      previousResponseId = response.id;
      const functionCallItems = functionCallContinuationItems(response);
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
      return responseToAgentModelResponse(response);
    },
    executeTool: async (call) => {
      log(`tool ${call.name}: ${JSON.stringify(call.arguments)}`);
      return await options.executeTool({
        name: call.name,
        args: call.arguments,
        providerCallId: call.id,
        rawArguments: typeof call.rawArguments === "string"
          ? call.rawArguments
          : JSON.stringify(call.arguments),
        signal: options.signal,
      });
    },
    finalTextFromToolResult: async ({ toolCall, toolResult }) =>
      await options.finalTextFromToolResult?.({
        name: toolCall.name,
        args: toolCall.arguments,
        output: toolResult.output,
      }),
    reviewFinalCandidate: async ({ text, iteration }) => {
      const disposition = await reviewProviderFinalCandidate({
        options,
        text,
        roundIndex: iteration,
      });
      if (disposition.kind === "final") {
        return { status: "accepted", text: disposition.text };
      }
      return { status: "continue", observation: disposition.observation };
    },
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
      const pending = newAgentLoopContinuationMessages(
        messages,
        sentContinuation,
        options.butlerData,
      );
      if (pending.items.length === 0) return "";
      const statelessRequestInput = [...codexStatelessInput, ...pending.items];
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
          __butler_codex_stateless_input: statelessRequestInput,
        }, options.signal, authOverride, options.onProviderStreamEvent, {
          attribution: options.usageAttribution,
          roundIndex: modelCallRound,
        }, undefined, options.providerRetryAttempts);
        afterAttributedModelResponse({
          attribution: options.usageAttribution,
          model,
          response,
          roundIndex: modelCallRound,
        });
        sentContinuation = pending.sent;
        codexStatelessInput.push(...pending.statelessItems);
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
