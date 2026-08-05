import { createToolResultModelPreviewContext } from
  "../../tools/tool-result-serialization.ts";
import type { ToolResultModelPreviewContext } from
  "../../tools/tool-result-model-preview.ts";
import { emptyResponseRecoveryObservation } from
  "./empty-response-recovery.ts";
import type {
  BtccAgentLoopEvent,
  BtccAgentLoopInput,
  BtccAgentLoopMessage,
  BtccAgentLoopOutput,
  BtccAgentLoopToolCall,
  BtccAgentLoopToolResult,
} from "./contracts.ts";
import type { ModelRoundResult } from "../ports/model-round.ts";
import {
  executePreparedBtccToolCall,
  prepareBtccToolCall,
} from "./tool-execution.ts";
import { synthesizeFinalResponse } from "./final-response-synthesis.ts";
import { publishModelRoundWaiting } from "./guided-tool-progress.ts";
import { renderPartialLimitResponse } from "./partial-limit-response.ts";
import { toolResultToMessage } from "./tool-result-message.ts";

const DEFAULT_MAX_ITERATIONS = 8;

function emit(
  events: BtccAgentLoopEvent[],
  onEvent: BtccAgentLoopInput["onEvent"],
  event: BtccAgentLoopEvent,
): void {
  events.push(event);
  onEvent?.(event);
}

export async function runBtccAgentLoop(
  input: BtccAgentLoopInput,
): Promise<BtccAgentLoopOutput> {
  const messages: BtccAgentLoopMessage[] = [{ role: "user", content: input.prompt }];
  const events: BtccAgentLoopEvent[] = [];
  const maxIterations = resolveMaxIterations(input);
  const toolResults: BtccAgentLoopToolResult[] = [];
  const modelPreviewContext = createToolResultModelPreviewContext();
  let continuation: unknown;
  let emptyResponseRecoveryUsed = false;
  let modelRoundIndex = 0;

  const runModelRound = async (request: {
    tools: readonly BtccAgentLoopInput["tools"][number][];
    instructions?: string;
    toolChoice?: "auto" | "required";
    iteration: number;
  }): Promise<ModelRoundResult> => {
    const roundIndex = (input.usageAttribution?.roundIndex ?? 0) + modelRoundIndex;
    modelRoundIndex += 1;
    const requestId = `btcc-model-round-${roundIndex}`;
    const resolveModelRef = () => input.resolveModelRef?.() ?? input.model ?? "";
    const publishWaiting = async (
      status: "started" | "completed" | "failed" | "cancelled",
    ): Promise<void> => {
      if (!input.turnId) return;
      const modelRef = resolveModelRef();
      await publishModelRoundWaiting(input.progress, {
        turnId: input.turnId,
        requestId,
        status,
        ...(modelRef ? { modelRef } : {}),
      });
    };
    await publishWaiting("started");
    try {
      const response = await input.modelRound.runRound({
        roundId: requestId,
        model: resolveModelRef(),
        messages: [...messages],
        instructions: request.instructions,
        tools: request.tools,
        toolChoice: request.toolChoice,
        reasoningEffort: input.reasoningEffort,
        signal: input.signal,
        attachments: input.attachments,
        butlerData: input.butlerData,
        usageAttribution: input.usageAttribution
          ? { ...input.usageAttribution, roundIndex }
          : undefined,
        cacheScope: input.cacheScope,
        providerRetryAttempts: input.providerRetryAttempts,
        continuation,
        onProviderStreamEvent: input.onProviderStreamEvent,
        onProviderResponseIdentity: input.onProviderResponseIdentity,
      });
      continuation = response.continuation;
      await publishWaiting("completed");
      return response;
    } catch (error) {
      await publishWaiting(input.signal?.aborted ? "cancelled" : "failed");
      throw error;
    }
  };

  const appendAssistantResponse = (response: ModelRoundResult): {
    text: string;
    calls: BtccAgentLoopToolCall[];
  } => {
    const text = response.text?.trim() ?? "";
    const calls = response.toolCalls ?? [];
    if (text || calls.length > 0) {
      messages.push(response.assistantMessage ?? {
        role: "assistant",
        content: text,
        toolCalls: calls,
        providerData: response.raw,
      });
    }
    return { text, calls };
  };

  const synthesizeFinalResponseForLoop = () => synthesizeFinalResponse({
    synthesis: input.finalSynthesis,
    messages,
    maxIterations,
    runModelRound,
    appendAssistantResponse,
    emit: (event) => emit(events, input.onEvent, event),
  });

  const recordToolResult = async (record: {
    call: BtccAgentLoopToolCall;
    result: BtccAgentLoopToolResult;
    iteration: number;
    evaluateStop?: boolean;
  }): Promise<string | null> => {
    toolResults.push(record.result);
    messages.push(toolResultToMessage({
      result: record.result,
      modelPreviewContext,
    }));
    emit(events, input.onEvent, {
      type: "tool_result",
      iteration: record.iteration,
      toolResult: record.result,
    });
    if (!record.result.ok || record.evaluateStop === false) return null;
    return (await input.finalTextFromToolResult?.({
      toolCall: record.call,
      toolResult: record.result,
    }))?.trim() || null;
  };

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    emit(events, input.onEvent, { type: "model_call", iteration });
    const tools = input.resolveTools?.() ?? input.tools;
    const response = await runModelRound({
      tools,
      instructions: input.instructions,
      toolChoice: input.resolveToolChoice?.() ?? input.toolChoice,
      iteration,
    });
    emit(events, input.onEvent, {
      type: "model_response",
      iteration,
      text: response.text,
    });

    const { text, calls } = appendAssistantResponse(response);
    if (calls.length === 0 && response.textToolCallNames?.length) {
      const lastMessage = messages.at(-1);
      if (lastMessage?.role === "assistant") messages.pop();
    }
    const textToolCallNames = [
      ...(response.textToolCallNames ?? []),
    ].filter((name, index, names) => names.indexOf(name) === index);
    if (textToolCallNames.length > 0 && input.onTextToolCalls) {
      const disposition = await input.onTextToolCalls({
        names: textToolCallNames,
        toolCalls: calls,
        text,
        iteration,
      });
      if (disposition.status === "fail") {
        if (disposition.error instanceof Error) throw disposition.error;
        throw new Error(String(disposition.error ?? "btcc_text_tool_call_rejected"));
      }
      const observation = disposition.observation.trim();
      if (!observation) throw new Error("btcc_text_tool_call_observation_missing");
      messages.push({ role: "user", content: observation });
      continue;
    }

    if (calls.length === 0) {
      const candidateAccepted = text && input.finalSynthesis?.acceptCandidate
        ? await input.finalSynthesis.acceptCandidate({ text, response })
        : false;
      const shouldSynthesize = toolResults.length > 0 && input.finalSynthesis && (
        (text && input.finalSynthesis.triggerAfterToolCandidate && !candidateAccepted) ||
        (!text && input.finalSynthesis.triggerAfterToolEmpty)
      );
      if (shouldSynthesize) {
        const synthesized = await synthesizeFinalResponseForLoop();
        if (synthesized) {
          return { finalText: synthesized, messages, events, stoppedByLimit: false };
        }
        return {
          finalText: renderPartialLimitResponse(toolResults),
          messages,
          events,
          stoppedByLimit: true,
        };
      }
      const recoveryObservation = text
        ? null
        : emptyResponseRecoveryObservation({
            recoveryUsed: emptyResponseRecoveryUsed,
            hasNextModelRound: iteration + 1 < maxIterations,
          });
      if (recoveryObservation) {
        emptyResponseRecoveryUsed = true;
        messages.push({ role: "user", content: recoveryObservation });
        continue;
      }
      if (!text) return { finalText: "", messages, events, stoppedByLimit: false };
      if (input.reviewFinalCandidate) {
        const review = await input.reviewFinalCandidate({ text, iteration });
        if (review.status === "continue") {
          const observation = review.observation.trim();
          if (!observation) throw new Error("btcc_agent_loop_final_candidate_observation_missing");
          messages.push({ role: "user", content: observation });
          continue;
        }
        return {
          finalText: review.text?.trim() || text,
          messages,
          events,
          stoppedByLimit: false,
        };
      }
      return { finalText: text, messages, events, stoppedByLimit: false };
    }

    const preparedCalls = calls.map((call) => prepareBtccToolCall({ tools }, call));
    await input.onAssistantTextBeforeTools?.({
      text,
      toolCalls: preparedCalls.map((prepared) => prepared.call),
      iteration,
    });
    const canRunBatchConcurrently = preparedCalls.length > 1 && preparedCalls.every((prepared) =>
      prepared.validationError === null && prepared.tool?.concurrencySafe === true,
    );

    if (canRunBatchConcurrently) {
      for (const prepared of preparedCalls) {
        emit(events, input.onEvent, { type: "tool_call", iteration, toolCall: prepared.call });
      }
      const results = await Promise.all(preparedCalls.map((prepared) =>
        executePreparedBtccToolCall(input, prepared, input.signal),
      ));
      let finalText: string | null = null;
      for (let index = 0; index < preparedCalls.length; index += 1) {
        const candidate = await recordToolResult({
          call: preparedCalls[index]!.call,
          result: results[index]!,
          iteration,
          evaluateStop: finalText === null,
        });
        if (finalText === null && candidate) finalText = candidate;
      }
      if (finalText) {
        messages.push({ role: "assistant", content: finalText });
        return { finalText, messages, events, stoppedByLimit: false };
      }
      continue;
    }

    for (const prepared of preparedCalls) {
      emit(events, input.onEvent, { type: "tool_call", iteration, toolCall: prepared.call });
      const result = await executePreparedBtccToolCall(input, prepared, input.signal);
      const finalText = await recordToolResult({
        call: prepared.call,
        result,
        iteration,
      });
      if (finalText) {
        messages.push({ role: "assistant", content: finalText });
        return { finalText, messages, events, stoppedByLimit: false };
      }
    }
  }

  emit(events, input.onEvent, { type: "loop_limit", iteration: maxIterations });
  const synthesizedText = (await input.onLoopLimit?.({
    messages,
    toolResults,
    maxIterations,
  }))?.trim();
  if (synthesizedText) {
    messages.push({ role: "assistant", content: synthesizedText });
    return { finalText: synthesizedText, messages, events, stoppedByLimit: true };
  }
  const finalSynthesisText = toolResults.length > 0
    ? await synthesizeFinalResponseForLoop()
    : null;
  if (finalSynthesisText) {
    return { finalText: finalSynthesisText, messages, events, stoppedByLimit: true };
  }
  const finalText = renderPartialLimitResponse(toolResults);
  messages.push({ role: "assistant", content: finalText });
  return { finalText, messages, events, stoppedByLimit: true };
}

function resolveMaxIterations(input: BtccAgentLoopInput): number {
  const requested = Math.max(1, input.maxIterations ?? DEFAULT_MAX_ITERATIONS);
  const budget = input.usageAttribution?.getBudgetState?.() ?? input.usageAttribution?.budgetState;
  if (!budget || !Number.isFinite(budget.requestCount) || !Number.isFinite(budget.maxRequests)) {
    return requested;
  }
  const remaining = Math.max(0, Math.trunc(budget.maxRequests - budget.requestCount));
  const reservedForFinalSynthesis = input.finalSynthesis ? 1 : 0;
  if (reservedForFinalSynthesis > 0 && remaining <= reservedForFinalSynthesis) return 1;
  return Math.max(
    1,
    Math.min(requested, remaining - reservedForFinalSynthesis),
  );
}
