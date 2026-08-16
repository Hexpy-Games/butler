import { createToolResultModelPreviewContext } from "../../tools/tool-result-serialization.ts";
import { emptyResponseRecoveryObservation } from "./empty-response-recovery.ts";
import type { BtccAgentLoopInput, BtccAgentLoopEvent, BtccAgentLoopOutput, BtccAgentLoopToolCall, BtccAgentLoopToolResult } from "./contracts.ts";
import { emitAgentLoopEvent as emit } from "./agent-loop-events.ts";
import type { ModelRoundResult } from "../ports/model-round.ts";
import { executePreparedBtccToolCall, prepareBtccToolCall } from "./tool-execution.ts";
import { synthesizeFinalResponse } from "./final-response-synthesis.ts";
import { publishModelRoundWaiting } from "./guided-tool-progress.ts";
import { renderPartialLimitResponse } from "./partial-limit-response.ts";
import { toolResultToMessage } from "./tool-result-message.ts";
import {
  emitExecutionWindowBoundary,
  modelRoundRequestId,
  resolveExecutionWindowSize,
  throwIfExecutionWindowAborted,
} from "./execution-window.ts";
import { modelRoundOutputBytes, prepareBoundedModelContext } from "./bounded-turn-context.ts";
import { appendAssistantResponse } from "./assistant-response.ts";
import { createTurnContinuationItems } from "./continuation-item-identity.ts";
import { finalRoundToolSurface, resolveRoundToolSurface } from "./round-tool-surface.ts";
export async function runBtccAgentLoop(
  input: BtccAgentLoopInput,
): Promise<BtccAgentLoopOutput> {
  const continuationItems = createTurnContinuationItems(input.prompt);
  const { messages } = continuationItems;
  const events: BtccAgentLoopEvent[] = [];
  const maxIterations = resolveExecutionWindowSize(input);
  const toolResults: BtccAgentLoopToolResult[] = [];
  const modelPreviewContext = createToolResultModelPreviewContext();
  let continuation: unknown;
  let emptyResponseRecoveryUsed = false;
  let modelRoundIndex = 0;
  let windowIndex = 0;
  let iteration = 0;
  const runModelRound = async (request: {
    tools: readonly BtccAgentLoopInput["tools"][number][]; toolSurfaceDigest?: string;
    instructions?: string;
    toolChoice?: "auto" | "required";
    iteration: number;
  }): Promise<ModelRoundResult> => {
    const roundIndex = (input.usageAttribution?.roundIndex ?? 0) + modelRoundIndex;
    modelRoundIndex += 1;
    const requestId = modelRoundRequestId(roundIndex, input.recoveryAttempt);
    const responseItemId = continuationItems.nextId();
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
      const replayMessages = input.operationResultReplay
        ? input.operationResultReplay.prepareMessages(messages, requestId, { statelessMessageBytes: input.modelRound.statelessMessageBytes, butlerData: input.butlerData })
        : [...messages];
      const bounded = await prepareBoundedModelContext({
        messages: replayMessages,
        instructions: request.instructions,
        tools: request.tools,
        toolChoice: request.toolChoice,
        budget: input.continuationBudget,
        roundId: requestId, responseItemId,
        phaseContinuityPrivateDigester: input.phaseContinuityPrivateDigester,
        statelessMessageBytes: input.modelRound.statelessMessageBytes, butlerData: input.butlerData,
      });
      const response = await input.modelRound.runRound({
        roundId: requestId,
        model: resolveModelRef(),
        messages: bounded.messages,
        instructions: request.instructions,
        tools: request.tools,
        ...(request.toolSurfaceDigest ? { toolSurfaceDigest: request.toolSurfaceDigest } : {}),
        toolChoice: request.toolChoice,
        reasoningEffort: input.reasoningEffort,
        signal: input.signal,
        attachments: input.attachments,
        imageCarrier: input.imageCarrier,
        imageCapability: input.imageCapability,
        imageManifests: input.imageManifests,
        verifiedImagePayloadPort: input.verifiedImagePayloadPort,
        butlerData: input.butlerData,
        usageAttribution: input.usageAttribution
          ? { ...input.usageAttribution, roundIndex }
          : undefined,
        cacheScope: input.cacheScope,
        stableProviderCachePrefix: input.stableProviderCachePrefix,
        providerRetryAttempts: input.providerRetryAttempts,
        continuation,
        ...(bounded.envelope
          ? { boundedContinuation: bounded.envelope }
          : {}),
        onProviderStreamEvent: input.onProviderStreamEvent,
        onProviderResponseIdentity: input.onProviderResponseIdentity,
      });
      input.operationResultReplay?.accepted(requestId, response);
      if (input.continuationBudget) {
        await input.continuationBudget.recordOutput({
          roundId: requestId,
          outputBytes: modelRoundOutputBytes(response),
        });
      }
      continuation = response.continuation;
      await publishWaiting("completed");
      return continuationItems.identifyResponse(response, responseItemId);
    } catch (error) {
      input.operationResultReplay?.failed(requestId);
      await publishWaiting(input.signal?.aborted ? "cancelled" : "failed");
      throw error;
    }
  };
  const synthesizeFinalResponseForLoop = (iterationBase: number) => synthesizeFinalResponse({
    synthesis: input.finalSynthesis,
    messages,
    maxIterations: iterationBase,
    runModelRound: (request) => runModelRound({ ...request, ...finalRoundToolSurface(request.tools, !!input.resolveTools) }),
    appendAssistantResponse: (response) => appendAssistantResponse(messages, response),
    emit: (event) => emit(events, input.onEvent, event),
  });
  const recordToolResult = async (record: {
    call: BtccAgentLoopToolCall;
    result: BtccAgentLoopToolResult;
    iteration: number;
    evaluateStop?: boolean;
  }): Promise<string | null> => {
    toolResults.push(record.result);
    continuationItems.push(toolResultToMessage({
      result: record.result, modelPreviewContext,
      operationResultCallId: input.resolveOperationResultCallId?.(record.call.id),
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

  while (true) {
    const windowEndIteration = iteration + maxIterations;
    while (iteration < windowEndIteration) {
      throwIfExecutionWindowAborted(input.signal);
      const currentIteration = iteration;
      iteration += 1;
      emit(events, input.onEvent, { type: "model_call", iteration: currentIteration });
    const { tools, ...toolSurfaceIdentity } = await resolveRoundToolSurface(input.resolveTools, input.tools);
    const response = await runModelRound({
      tools,
      ...toolSurfaceIdentity,
      instructions: input.instructions,
      toolChoice: input.resolveToolChoice?.() ?? input.toolChoice,
      iteration: currentIteration,
    });
    emit(events, input.onEvent, {
      type: "model_response",
      iteration: currentIteration,
      text: response.text,
    });

    const { text, calls } = appendAssistantResponse(messages, response);
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
        iteration: currentIteration,
      });
      if (disposition.status === "fail") {
        if (disposition.error instanceof Error) throw disposition.error;
        throw new Error(String(disposition.error ?? "btcc_text_tool_call_rejected"));
      }
      const observation = disposition.observation.trim();
      if (!observation) throw new Error("btcc_text_tool_call_observation_missing");
      continuationItems.push({ role: "user", content: observation });
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
        const synthesized = await synthesizeFinalResponseForLoop(iteration);
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
            hasNextModelRound: iteration < windowEndIteration,
          });
      if (recoveryObservation) {
        emptyResponseRecoveryUsed = true;
        continuationItems.push({ role: "user", content: recoveryObservation });
        continue;
      }
      if (!text && input.onExecutionWindowBoundary) {
        break;
      }
      if (!text) return { finalText: "", messages, events, stoppedByLimit: false };
      if (input.reviewFinalCandidate) {
        const review = await input.reviewFinalCandidate({
          text,
          iteration: currentIteration,
        });
        if (review.status === "continue") {
          const observation = review.observation.trim();
          if (!observation) throw new Error("btcc_agent_loop_final_candidate_observation_missing");
          continuationItems.push({ role: "user", content: observation });
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

    if (input.continuationBudget) {
      await input.continuationBudget.recordToolRound({ roundId: `btcc-tool-round-${currentIteration}` });
    }

    const preparedCalls = calls.map((call) => prepareBtccToolCall({ tools }, call));
    await input.onAssistantTextBeforeTools?.({
      text,
      toolCalls: preparedCalls.map((prepared) => prepared.call),
      iteration: currentIteration,
    });
    const canRunBatchConcurrently = preparedCalls.length > 1 && preparedCalls.every((prepared) =>
      prepared.validationError === null && prepared.tool?.concurrencySafe === true,
    );

    if (canRunBatchConcurrently) {
      for (const prepared of preparedCalls) {
        emit(events, input.onEvent, {
          type: "tool_call",
          iteration: currentIteration,
          toolCall: prepared.call,
        });
      }
      const results = await Promise.all(preparedCalls.map((prepared) =>
        executePreparedBtccToolCall(input, prepared, input.signal),
      ));
      let finalText: string | null = null;
      for (let index = 0; index < preparedCalls.length; index += 1) {
        const candidate = await recordToolResult({
          call: preparedCalls[index]!.call,
          result: results[index]!,
          iteration: currentIteration,
          evaluateStop: finalText === null,
        });
        if (finalText === null && candidate) finalText = candidate;
      }
      if (finalText) {
        continuationItems.push({ role: "assistant", content: finalText });
        return { finalText, messages, events, stoppedByLimit: false };
      }
      continue;
    }

    for (const prepared of preparedCalls) {
      emit(events, input.onEvent, {
        type: "tool_call",
        iteration: currentIteration,
        toolCall: prepared.call,
      });
      const result = await executePreparedBtccToolCall(input, prepared, input.signal);
      const finalText = await recordToolResult({
        call: prepared.call,
        result,
        iteration: currentIteration,
      });
      if (finalText) {
        continuationItems.push({ role: "assistant", content: finalText });
        return { finalText, messages, events, stoppedByLimit: false };
      }
    }
  }
    const boundaryObservation = await emitExecutionWindowBoundary({
      events,
      onEvent: input.onEvent,
      callback: input.onExecutionWindowBoundary,
      signal: input.signal,
      windowIndex,
      iteration,
      messages,
      toolResults,
    });
    if (boundaryObservation !== undefined) {
      continuationItems.push({ role: "user", content: boundaryObservation });
      windowIndex += 1;
      continue;
    }
    break;
  }
  const synthesizedText = (await input.onLoopLimit?.({
    messages,
    toolResults,
    maxIterations,
  }))?.trim();
  if (synthesizedText) {
    continuationItems.push({ role: "assistant", content: synthesizedText });
    return { finalText: synthesizedText, messages, events, stoppedByLimit: true };
  }
  const finalSynthesisText = toolResults.length > 0
    ? await synthesizeFinalResponseForLoop(iteration)
    : null;
  if (finalSynthesisText) {
    return { finalText: finalSynthesisText, messages, events, stoppedByLimit: true };
  }
  const finalText = renderPartialLimitResponse(toolResults);
  continuationItems.push({ role: "assistant", content: finalText });
  return { finalText, messages, events, stoppedByLimit: true };
}
