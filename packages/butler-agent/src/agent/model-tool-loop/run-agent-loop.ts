import { serializeToolResultPayloadForProvider } from "../context/completed-tool-evidence.ts";
import type { ToolEvidenceRetentionContext } from "../context/tool-evidence-retention.ts";
import {
  blockCapacityObservation,
  blockCapacityToolOutput,
  partitionSemanticToolBatch,
} from "./tool-batch-capacity.ts";
import type {
  AgentLoopEvent,
  AgentLoopInput,
  AgentLoopMessage,
  AgentLoopOutput,
  AgentLoopToolCall,
  AgentLoopToolResult,
} from "./contracts.ts";
import {
  executePreparedToolCall,
  prepareToolCall,
} from "./tool-call-execution.ts";

const DEFAULT_MAX_ITERATIONS = 8;

function emit(
  events: AgentLoopEvent[],
  onEvent: AgentLoopInput["onEvent"],
  event: AgentLoopEvent,
): void {
  events.push(event);
  onEvent?.(event);
}

function toolResultToMessage(input: {
  result: AgentLoopToolResult;
  evidenceRetention?: ToolEvidenceRetentionContext;
}): AgentLoopMessage {
  const payload = input.result.ok ? { ok: true, output: input.result.output } : {
    ok: false,
    ...(input.result.output !== undefined
      ? { output: input.result.output }
      : { error: input.result.error ?? "unknown tool error" }),
  };
  return {
    role: "tool",
    toolCallId: input.result.toolCallId,
    name: input.result.name,
    content: serializeToolResultPayloadForProvider({
      payload,
      toolName: input.result.name,
      toolCallId: input.result.toolCallId,
      evidenceRetention: input.evidenceRetention,
    }),
  };
}

function renderPartialLimitResponse(results: AgentLoopToolResult[]): string {
  const lines = [
    "I reached the available tool budget before a complete final answer was produced.",
  ];
  if (results.length > 0) {
    lines.push("What I completed:");
    for (const result of results) {
      lines.push(`- ${result.name}: ${result.ok ? "ok" : `failed (${result.error ?? "unknown error"})`}`);
    }
  }
  lines.push("What remains: a final synthesis may need another turn.");
  return lines.join("\n");
}

interface ToolStopCandidate {
  type: "tool_final_text";
  iteration: number;
  toolCall: AgentLoopToolCall;
  toolResult: AgentLoopToolResult;
  finalText?: string;
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopOutput> {
  const messages = [...input.messages];
  const events: AgentLoopEvent[] = [];
  const maxIterations = Math.max(1, input.maxIterations ?? DEFAULT_MAX_ITERATIONS);
  const toolResults: AgentLoopToolResult[] = [];

  const recordToolResult = async (inputRecord: {
    call: AgentLoopToolCall;
    result: AgentLoopToolResult;
    iteration: number;
    evaluateStop?: boolean;
  }): Promise<ToolStopCandidate | null> => {
    const { call, evaluateStop = true, result, iteration } = inputRecord;
    toolResults.push(result);
    const toolMessage = toolResultToMessage({
      result,
      evidenceRetention: input.evidenceRetention,
    });
    messages.push(toolMessage);
    emit(events, input.onEvent, {
      type: "tool_result",
      iteration,
      toolResult: result,
    });

    if (!result.ok) {
      return null;
    }

    if (!evaluateStop) return null;

    const finalText = (await input.finalTextFromToolResult?.({
      toolCall: call,
      toolResult: result,
    }))?.trim();
    if (finalText) {
      return {
        type: "tool_final_text",
        iteration,
        toolCall: call,
        toolResult: result,
        finalText,
      };
    }

    return null;
  };

  const finishWithStopCandidate = async (candidate: ToolStopCandidate): Promise<AgentLoopOutput> => {
    let finalText = candidate.finalText;
    if (!finalText) finalText = "";
    messages.push({
      role: "assistant",
      content: finalText,
    });
    return {
      finalText,
      messages,
      events,
      stoppedByLimit: false,
    };
  };

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    emit(events, input.onEvent, { type: "model_call", iteration });
    const response = await input.callModel({
      messages,
      tools: input.tools,
      iteration,
    });
    emit(events, input.onEvent, {
      type: "model_response",
      iteration,
      text: response.text,
    });

    if (response.text?.trim()) {
      messages.push({
        role: "assistant",
        content: response.text.trim(),
      });
    }

    const calls = response.toolCalls ?? [];
    if (calls.length === 0) {
      const finalText = response.text?.trim();
      if (finalText && input.reviewFinalCandidate) {
        const review = await input.reviewFinalCandidate({ text: finalText, iteration });
        if (review.status === "continue") {
          const observation = review.observation.trim();
          if (!observation) throw new Error("agent_loop_final_candidate_observation_missing");
          messages.push({ role: "user", content: observation });
          continue;
        }
        return {
          finalText: review.text?.trim() || finalText,
          messages,
          events,
          stoppedByLimit: false,
        };
      }
      return {
        finalText: finalText || "",
        messages,
        events,
        stoppedByLimit: false,
      };
    }

    const batch = partitionSemanticToolBatch(calls);
    await input.onAssistantTextBeforeTools?.({
      text: response.text?.trim() ?? "",
      toolCalls: batch.executable,
      iteration,
    });

    const preparedCalls = batch.executable.map((call) => prepareToolCall(input, call));
    const recordDeferredCalls = async (): Promise<void> => {
      for (const call of batch.deferred) {
        const observation = blockCapacityObservation({
          toolCallId: call.id,
          toolName: call.name,
          deferredCount: batch.deferred.length,
          turnId: input.evidenceRetention?.turnId,
        });
        await recordToolResult({
          call,
          result: {
            toolCallId: call.id,
            name: call.name,
            ok: false,
            error: observation.summary,
            output: blockCapacityToolOutput(observation),
          },
          iteration,
          evaluateStop: false,
        });
      }
    };
    const canRunBatchConcurrently = preparedCalls.length > 1 && preparedCalls.every((prepared) =>
      prepared.validationError === null &&
      prepared.tool?.concurrencySafe === true,
    );

    if (canRunBatchConcurrently) {
      for (const prepared of preparedCalls) {
        emit(events, input.onEvent, {
          type: "tool_call",
          iteration,
          toolCall: prepared.call,
        });
      }
      const results = await Promise.all(preparedCalls.map((prepared) =>
        executePreparedToolCall(input, prepared),
      ));
      let stop: ToolStopCandidate | null = null;
      for (let index = 0; index < preparedCalls.length; index += 1) {
        const candidate = await recordToolResult({
          call: preparedCalls[index]!.call,
          evaluateStop: stop === null,
          result: results[index]!,
          iteration,
        });
        if (!stop && candidate) stop = candidate;
      }
      await recordDeferredCalls();
      if (stop) return finishWithStopCandidate(stop);
      continue;
    }

    for (const prepared of preparedCalls) {
      emit(events, input.onEvent, {
        type: "tool_call",
        iteration,
        toolCall: prepared.call,
      });
      const result = await executePreparedToolCall(input, prepared);
      const stop = await recordToolResult({
        call: prepared.call,
        result,
        iteration,
      });
      if (stop) return finishWithStopCandidate(stop);
    }
    await recordDeferredCalls();
  }

  emit(events, input.onEvent, {
    type: "loop_limit",
    iteration: maxIterations,
  });
  const synthesizedText = (await input.onLoopLimit?.({
    messages,
    toolResults,
    maxIterations,
  }))?.trim();
  const finalText = synthesizedText || renderPartialLimitResponse(toolResults);
  messages.push({
    role: "assistant",
    content: finalText,
  });
  return {
    finalText,
    messages,
    events,
    stoppedByLimit: true,
  };
}
