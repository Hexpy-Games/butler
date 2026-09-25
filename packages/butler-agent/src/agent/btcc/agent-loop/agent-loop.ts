import {
  beginToolResultModelPreviewBatch,
  createToolResultModelPreviewContext,
  MAX_PROVIDER_TOOL_RESULT_BYTES,
} from "../../tools/tool-result-serialization.ts";
import { emptyResponseRecoveryObservation } from "./empty-response-recovery.ts";
import type { BtccAgentLoopInput, BtccAgentLoopEvent, BtccAgentLoopOutput, BtccAgentLoopToolCall, BtccAgentLoopToolResult, BtccToolResultOutcome } from "./contracts.ts";
import { emitAgentLoopEvent as emit } from "./agent-loop-events.ts";
import type { ModelRoundResult } from "../ports/model-round.ts";
import { executePreparedBtccToolCall, prepareBtccToolCall } from "./tool-execution.ts";
import { synthesizeFinalResponse } from "./final-response-synthesis.ts";
import { toolResultToMessage } from "./tool-result-message.ts";
import { toolResultBatchModelFacingBudget } from "./bounded-turn-context.ts";
import { appendAssistantResponse } from "./assistant-response.ts";
import { createTurnContinuationItems } from "./continuation-item-identity.ts";
import { finalRoundToolSurface, resolveRoundToolSurface } from "./round-tool-surface.ts";
import { pendingAuthority, unexecutedAuthorityCall } from "./loop-continuation.ts";
import { nextTurnAfterToolBatch, throwIfAgentLoopAborted } from "./agent-loop-round.ts";
import { createAgentLoopModelRound } from "./agent-loop-model-round.ts";
import { createFailureRepetitionTracker } from "./failure-repetition.ts";
export async function runBtccAgentLoop(
  input: BtccAgentLoopInput,
): Promise<BtccAgentLoopOutput> {
  const restored = input.authorityContinuation;
  if (restored && !input.authorityDecision) throw new Error("authority_decision_missing");
  const continuationItems = createTurnContinuationItems(input.prompt, restored);
  const { messages } = continuationItems;
  const events: BtccAgentLoopEvent[] = [];
  const toolResults: BtccAgentLoopToolResult[] = [...restored?.toolResults ?? []];
  const modelPreviewContext = createToolResultModelPreviewContext();
  const repetition = createFailureRepetitionTracker(restored?.failureRepetition);
  let continuation: unknown = restored?.providerContinuation;
  let emptyResponseRecoveryUsed = restored?.emptyResponseRecoveryUsed ?? false;
  let modelRoundIndex = restored?.modelRoundIndex ?? 0;
  let iteration = restored?.iteration ?? 0;
  let finalReportRound = false;
  const beginFinalReport = () => {
    finalReportRound = true;
    continuationItems.push({ role: "user", content:
      "Execution is settled. Write the final factual report as your normal assistant response now; the runtime delivers it to the recipient automatically. No reporting tool or further tool call is needed. Include the outcome, checks performed, and any remaining work from the results already received.",
    });
  };
  let resumedToolCall = input.resumedToolCall;
  let resumedBatch = restored?.batch;
  const appendObservation = (observation: string | { content: string; requestSegmentKind: "current_user_request" | "project_ledger_and_work_authority" }) => {
    const message = typeof observation === "string"
      ? { content: observation, requestSegmentKind: "current_user_request" as const }
      : observation;
    if (message.content.trim()) continuationItems.push({ role: "user", ...message });
  };
  if (restored) input = { ...input, instructions: restored.instructions,
    stableProviderCachePrefix: restored.stableProviderCachePrefix };
  const runModelRound = createAgentLoopModelRound({
    input, messages, continuationItems, appendObservation,
    claimRoundIndex: () => modelRoundIndex++,
    onDirection: () => { finalReportRound = false; },
    getContinuation: () => continuation,
    setContinuation: (value) => { continuation = value; },
  });
  const synthesizeFinalResponseForLoop = (iterationBase: number) => synthesizeFinalResponse({
    synthesis: input.finalSynthesis,
    messages,
    iterationBase,
    runModelRound: (request) => runModelRound({ ...request, ...finalRoundToolSurface(request.tools, !!input.resolveTools) }),
    appendAssistantResponse: (response) => appendAssistantResponse(messages, response),
    emit: (event) => emit(events, input.onEvent, event),
  });
  const recordToolResult = async (record: {
    call: BtccAgentLoopToolCall;
    result: BtccAgentLoopToolResult;
    iteration: number;
    evaluateStop?: boolean;
  }): Promise<BtccToolResultOutcome | null> => {
    // The accepted call remains unanswered until the user decides. Never send
    // a fake successful tool result to the provider or the activity transcript.
    if (pendingAuthority(record.result.output)) return { kind: "suspend", reason: "authority_pending" };
    toolResults.push(record.result);
    const operationResultCallId = input.resolveOperationResultCallId?.(record.call.id);
    const attachExactReference = record.call.name !== "read_operation_results" &&
      operationResultCallId;
    continuationItems.push(toolResultToMessage({
      result: repetition.annotate(record.call, record.result), modelPreviewContext,
      ...(operationResultCallId ? { operationResultCallId } : {}),
      ...(attachExactReference
        ? {
            operationResultReference:
              input.operationResultReplay?.referenceForCall(operationResultCallId) ?? undefined,
            exactReadReference:
              input.operationResultReplay?.previewReferenceForCall(operationResultCallId) ?? undefined,
          }
        : {}),
    }));
    emit(events, input.onEvent, {
      type: "tool_result",
      iteration: record.iteration,
      toolResult: record.result,
    });
    if (!record.result.ok || record.evaluateStop === false) return null;
    return await input.outcomeFromToolResult?.({
      toolCall: record.call,
      toolResult: record.result,
    }) ?? null;
  };

  while (true) {
    throwIfAgentLoopAborted(input.signal);
    const currentIteration = iteration;
    iteration += 1;
    const batchToResume = resumedBatch;
    resumedBatch = undefined;
    if (!batchToResume && !resumedToolCall) {
      for (const observation of await input.beforeModelRound?.() ?? []) {
        // Apply steering before choosing tools, not inside an already tool-free request.
        if (typeof observation === "string" || observation.requestSegmentKind === "current_user_request") {
          finalReportRound = false;
        }
        appendObservation(observation);
      }
    }
    const surface = batchToResume
      ? { tools: batchToResume.tools }
      : finalReportRound
      ? finalRoundToolSurface([], Boolean(input.resolveTools))
      : await resolveRoundToolSurface(input.resolveTools, input.tools);
    let tools = surface.tools;
    let response: ModelRoundResult | undefined;
    let text: string;
    let calls: BtccAgentLoopToolCall[];
    if (batchToResume) {
      calls = batchToResume.calls;
      text = "";
    } else if (resumedToolCall) {
      // This call was already chosen and approved. Restore it into the same
      // tool batch path, then let the model reason from its actual result.
      calls = [resumedToolCall];
      text = "";
      continuationItems.push({ role: "assistant", content: "", toolCalls: calls });
      resumedToolCall = undefined;
    } else {
      emit(events, input.onEvent, { type: "model_call", iteration: currentIteration });
      const roundRequest: Parameters<typeof runModelRound>[0] = {
        tools,
        toolSurfaceDigest: surface.toolSurfaceDigest,
        instructions: input.instructions,
        toolChoice: finalReportRound
          ? undefined
          : input.resolveToolChoice?.() ?? input.toolChoice,
        iteration: currentIteration,
      };
      response = await runModelRound(roundRequest);
      // Compaction can consume steering and replace the report-only surface.
      // Execute against exactly the surface sent to the model.
      tools = roundRequest.tools;
      emit(events, input.onEvent, {
        type: "model_response",
        iteration: currentIteration,
        text: response.text,
      });
      ({ text, calls } = appendAssistantResponse(messages, response));
    }
    if (calls.length === 0 && response?.textToolCallNames?.length) {
      const lastMessage = messages.at(-1);
      if (lastMessage?.role === "assistant") messages.pop();
    }
    const textToolCallNames = [
      ...(response?.textToolCallNames ?? []),
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
      const candidateAccepted = text && response && input.finalSynthesis?.acceptCandidate
        ? await input.finalSynthesis.acceptCandidate({ text, response })
        : false;
      const shouldSynthesize = toolResults.length > 0 && input.finalSynthesis && (
        (text && input.finalSynthesis.triggerAfterToolCandidate && !candidateAccepted) ||
        (!text && input.finalSynthesis.triggerAfterToolEmpty)
      );
      if (shouldSynthesize) {
        const synthesized = await synthesizeFinalResponseForLoop(iteration);
        text = synthesized || text;
        if (!input.reviewFinalCandidate) return { finalText: text, messages, events };
      }
      const recoveryObservation = text
        ? null
        : emptyResponseRecoveryObservation({
            recoveryUsed: emptyResponseRecoveryUsed,
            hasNextModelRound: true,
          });
      if (recoveryObservation) {
        emptyResponseRecoveryUsed = true;
        continuationItems.push({ role: "user", content: repetition.nudge("empty_response", recoveryObservation) });
        continue;
      }
      if (input.reviewFinalCandidate) {
        const review = await input.reviewFinalCandidate({
          text,
          iteration: currentIteration,
        });
        if (review.status === "wait") {
          return { finalText: "", suspension: "waiting_for_worker", messages, events };
        }
        if (review.status === "continue") {
          finalReportRound = false;
          const observation = review.observation.trim();
          if (!observation) throw new Error("btcc_agent_loop_final_candidate_observation_missing");
          continuationItems.push({ role: "user", content: repetition.nudge("final_candidate_review", observation) });
          continue;
        }
        return {
          finalText: review.text?.trim() || text,
          messages,
          events,
        };
      }
      return { finalText: text, messages, events };
    }

    if (input.continuationBudget && !batchToResume) {
      await input.continuationBudget.recordToolRound({ roundId: `btcc-tool-round-${currentIteration}` });
    }

    const preparedCalls = calls.map((call) => prepareBtccToolCall({ tools }, call));
    beginToolResultModelPreviewBatch(modelPreviewContext, {
      resultCount: preparedCalls.length,
      maxBytes: toolResultBatchModelFacingBudget({
        messages,
        instructions: input.instructions,
        tools,
        toolChoice: finalReportRound
          ? undefined
          : input.resolveToolChoice?.() ?? input.toolChoice,
        maxModelFacingBytes: input.maxModelFacingBytes,
        budgetMaxModelFacingBytes: input.continuationBudget?.state.limits.maxModelFacingBytes,
        resultCount: preparedCalls.length,
        perResultMaxBytes: MAX_PROVIDER_TOOL_RESULT_BYTES,
      }),
    });
    if (!batchToResume) await input.onAssistantTextBeforeTools?.({
      text,
      toolCalls: preparedCalls.map((prepared) => prepared.call),
      iteration: currentIteration,
    });
    const canRunBatchConcurrently = !batchToResume && preparedCalls.length > 1 && preparedCalls.every((prepared) =>
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
      let finalOutcome: BtccToolResultOutcome | null = null;
      for (let index = 0; index < preparedCalls.length; index += 1) {
        const candidate = await recordToolResult({
          call: preparedCalls[index]!.call,
          result: results[index]!,
          iteration: currentIteration,
          evaluateStop: finalOutcome === null,
        });
        if (finalOutcome === null && candidate) finalOutcome = candidate;
      }
      if (finalOutcome?.kind === "reply") {
        const finalText = finalOutcome.text.trim();
        if (finalText) continuationItems.push({ role: "assistant", content: finalText });
        return { finalText, messages, events };
      }
      if (finalOutcome?.kind === "suspend") {
        return { finalText: "", suspension: finalOutcome.reason, messages, events };
      }
      const disposition = await nextTurnAfterToolBatch(
        input,
        preparedCalls.map((item) => item.call),
        results,
        currentIteration,
      );
      if (disposition === "wait") {
        return { finalText: "", suspension: "waiting_for_worker", messages, events };
      }
      if (disposition === "final_report") {
        beginFinalReport();
      }
      continue;
    }

    const batchResults: BtccAgentLoopToolResult[] = [...batchToResume?.results ?? []];
    const decision = batchToResume ? input.authorityDecision : undefined;
    for (let callIndex = batchToResume?.nextCallIndex ?? 0; callIndex < preparedCalls.length; callIndex++) {
      const prepared = preparedCalls[callIndex]!;
      emit(events, input.onEvent, {
        type: "tool_call",
        iteration: currentIteration,
        toolCall: prepared.call,
      });
      const result = decision && decision.action !== "allow"
        ? unexecutedAuthorityCall(prepared.call, decision, callIndex === batchToResume!.nextCallIndex)
        : await executePreparedBtccToolCall(input, prepared, input.signal);
      if (decision && decision.action !== "allow") await input.onUnexecutedToolCall?.(prepared.call, result);
      const pending = pendingAuthority(result.output);
      if (pending) {
        const callId = input.resolveOperationResultCallId?.(prepared.call.id);
        if (!callId) throw new Error("authority_source_call_missing");
        return { finalText: "", suspension: "authority_pending", messages, events,
          authorityContinuation: {
            requestRef: pending.requestRef, callId, messages,
            nextItemOrdinal: continuationItems.ordinal(), providerContinuation: continuation,
            instructions: input.instructions, stableProviderCachePrefix: input.stableProviderCachePrefix,
            modelRoundIndex, iteration: currentIteration, emptyResponseRecoveryUsed, toolResults, failureRepetition: repetition.snapshot(),
            batch: { tools, calls, nextCallIndex: callIndex, results: batchResults },
          },
        };
      }
      batchResults.push(result);
      const finalOutcome = await recordToolResult({
        call: prepared.call,
        result,
        iteration: currentIteration,
      });
      if (finalOutcome?.kind === "reply") {
        const finalText = finalOutcome.text.trim();
        if (finalText) continuationItems.push({ role: "assistant", content: finalText });
        return { finalText, messages, events };
      }
      if (finalOutcome?.kind === "suspend") {
        return { finalText: "", suspension: finalOutcome.reason, messages, events };
      }
    }
    if (decision?.action === "modify") {
      continuationItems.push({ role: "user", content: decision.input, requestSegmentKind: "current_user_request" });
    }
    const disposition = await nextTurnAfterToolBatch(
      input,
      preparedCalls.map((item) => item.call),
      batchResults,
      currentIteration,
    );
    if (disposition === "wait") {
      return { finalText: "", suspension: "waiting_for_worker", messages, events };
    }
    if (disposition === "final_report") {
      beginFinalReport();
    }
  }
}
