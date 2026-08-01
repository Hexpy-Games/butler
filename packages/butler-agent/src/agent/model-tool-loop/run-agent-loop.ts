import { serializeToolResultPayloadForProvider } from "./tool-result-serialization.ts";
import { structuredToolResultModelPreview } from "./tool-result-model-preview.ts";
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
import {
  extractAgentLoopImageAttachments,
  withoutAgentLoopImageAttachments,
} from "./tool-result-media.ts";

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
}): AgentLoopMessage {
  const imageAttachments = extractAgentLoopImageAttachments(
    input.result.output,
    input.result.name,
  );
  const providerOutput = withoutAgentLoopImageAttachments(
    modelFacingToolOutput(input.result),
  );
  const payload = input.result.ok ? { ok: true, output: providerOutput } : {
    ok: false,
    error: input.result.error ?? "unknown tool error",
    ...(providerOutput !== undefined
      ? { output: providerOutput }
      : {}),
  };
  return {
    role: "tool",
    toolCallId: input.result.toolCallId,
    name: input.result.name,
    content: serializeToolResultPayloadForProvider(payload),
    ...(imageAttachments.length > 0 ? { imageAttachments } : {}),
  };
}

function modelFacingToolOutput(result: AgentLoopToolResult): unknown {
  if (
    result.output === undefined ||
    (result.name !== "web_search" && result.name !== "web_read")
  ) return result.output;
  return structuredToolResultModelPreview({
    toolName: result.name,
    output: result.output,
  }) ?? result.output;
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
    const toolMessage = toolResultToMessage({ result });
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

    const preparedCalls = calls.map((call) => prepareToolCall(input, call));
    await input.onAssistantTextBeforeTools?.({
      text: response.text?.trim() ?? "",
      toolCalls: preparedCalls.map((prepared) => prepared.call),
      iteration,
    });
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
