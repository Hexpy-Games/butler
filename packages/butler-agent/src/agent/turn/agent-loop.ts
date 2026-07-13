import { serializeToolResultPayloadForProvider } from "../context/completed-tool-evidence.ts";
import type { ToolEvidenceRetentionContext } from "../context/tool-evidence-retention.ts";
import {
  blockCapacityObservation,
  blockCapacityToolOutput,
  partitionSemanticToolBatch,
} from "./tool-batch-capacity.ts";

export type AgentLoopRole = "system" | "user" | "assistant" | "tool";

export interface AgentLoopMessage {
  role: AgentLoopRole;
  content: string;
  toolCallId?: string;
  name?: string;
}

export interface AgentLoopToolDefinition {
  name: string;
  description: string;
  inputSchema?: {
    type: "object";
    required?: string[];
    properties?: Record<string, unknown>;
    additionalProperties?: boolean;
  };
  concurrencySafe?: boolean;
}

export interface AgentLoopToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentLoopToolResult {
  toolCallId: string;
  name: string;
  ok: boolean;
  output?: unknown;
  error?: string;
}

export interface AgentLoopModelResponse {
  text?: string;
  toolCalls?: AgentLoopToolCall[];
  raw?: unknown;
}

export interface AgentLoopModelInput {
  messages: AgentLoopMessage[];
  tools: AgentLoopToolDefinition[];
  iteration: number;
}

export interface AgentLoopEvent {
  type:
    | "model_call"
    | "model_response"
    | "tool_call"
    | "tool_result"
    | "loop_limit";
  iteration: number;
  toolCall?: AgentLoopToolCall;
  toolResult?: AgentLoopToolResult;
  text?: string;
}

export interface AgentLoopInput {
  messages: AgentLoopMessage[];
  tools: AgentLoopToolDefinition[];
  maxIterations?: number;
  evidenceRetention?: ToolEvidenceRetentionContext;
  callModel: (input: AgentLoopModelInput) => Promise<AgentLoopModelResponse>;
  onAssistantTextBeforeTools?: (input: {
    text: string;
    toolCalls: AgentLoopToolCall[];
    iteration: number;
  }) => Promise<void> | void;
  executeTool: (call: AgentLoopToolCall) => Promise<unknown>;
  finalTextFromToolResult?: (input: {
    toolCall: AgentLoopToolCall;
    toolResult: AgentLoopToolResult;
  }) => Promise<string | null | undefined> | string | null | undefined;
  reviewFinalCandidate?: (input: {
    text: string;
    iteration: number;
  }) => Promise<
    | { status: "accepted"; text?: string }
    | { status: "continue"; observation: string }
  >;
  onEvent?: (event: AgentLoopEvent) => void;
  onLoopLimit?: (input: {
    messages: AgentLoopMessage[];
    toolResults: AgentLoopToolResult[];
    maxIterations: number;
  }) => Promise<string> | string;
}

export interface AgentLoopOutput {
  finalText: string;
  messages: AgentLoopMessage[];
  events: AgentLoopEvent[];
  stoppedByLimit: boolean;
}

const DEFAULT_MAX_ITERATIONS = 8;
const GENERIC_AGENT_LOOP_TURN_ID = "generic-agent-loop";

function emit(
  events: AgentLoopEvent[],
  onEvent: AgentLoopInput["onEvent"],
  event: AgentLoopEvent,
): void {
  events.push(event);
  onEvent?.(event);
}

function validateToolInput(
  tool: AgentLoopToolDefinition | undefined,
  call: AgentLoopToolCall,
): string | null {
  if (!tool) return `No such tool available: ${call.name}`;
  const schema = tool.inputSchema;
  if (!schema) return null;
  for (const key of schema.required ?? []) {
    if (!(key in call.arguments)) {
      return `Tool ${call.name} requires argument: ${key}`;
    }
  }
  if (schema.additionalProperties === false && schema.properties) {
    const allowed = new Set(Object.keys(schema.properties));
    const extra = Object.keys(call.arguments).filter((key) => !allowed.has(key));
    if (extra.length > 0) {
      return `Tool ${call.name} received unsupported argument(s): ${extra.join(", ")}`;
    }
  }
  return null;
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

interface PreparedToolCall {
  call: AgentLoopToolCall;
  tool: AgentLoopToolDefinition | undefined;
  validationError: string | null;
}

interface ToolStopCandidate {
  type: "tool_final_text";
  iteration: number;
  toolCall: AgentLoopToolCall;
  toolResult: AgentLoopToolResult;
  finalText?: string;
}

function prepareToolCall(input: AgentLoopInput, call: AgentLoopToolCall): PreparedToolCall {
  const tool = input.tools.find((candidate) => candidate.name === call.name);
  return {
    call,
    tool,
    validationError: validateToolInput(tool, call),
  };
}

async function executePreparedToolCall(
  input: AgentLoopInput,
  prepared: PreparedToolCall,
): Promise<AgentLoopToolResult> {
  if (prepared.validationError) {
    const observation = genericToolInvalidArgumentsObservation({
      call: prepared.call,
      message: prepared.validationError,
    });
    return {
      toolCallId: prepared.call.id,
      name: prepared.call.name,
      ok: false,
      error: observation.summary,
      output: toolObservationResult(observation),
    };
  }

  return input.executeTool(prepared.call).then(
    (output): AgentLoopToolResult => ({
      toolCallId: prepared.call.id,
      name: prepared.call.name,
      ok: true,
      output,
    }),
    (error): AgentLoopToolResult => ({
      toolCallId: prepared.call.id,
      name: prepared.call.name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

function genericToolInvalidArgumentsObservation(input: {
  call: AgentLoopToolCall;
  message: string;
}): {
  observationId: string;
  turnId: string;
  kind: "tool_invalid_arguments" | "tool_unavailable";
  visibility: "model";
  summary: string;
  modelVisibleContent: string;
  causedByToolCallId: string;
  createdAt: string;
} {
  const kind = input.message.startsWith("No such tool available:")
    ? "tool_unavailable"
    : "tool_invalid_arguments";
  return {
    observationId: `obs-${input.call.id}`,
    turnId: GENERIC_AGENT_LOOP_TURN_ID,
    kind,
    visibility: "model",
    summary: input.message,
    modelVisibleContent: [
      `Tool: ${input.call.name}`,
      `Observation: ${input.message}`,
      `Arguments: ${JSON.stringify(input.call.arguments)}`,
      "Use this observation to retry with the tool schema: include required fields, remove unsupported fields, or select an available tool.",
    ].join("\n"),
    causedByToolCallId: input.call.id,
    createdAt: new Date(0).toISOString(),
  };
}

function toolObservationResult(observation: ReturnType<typeof genericToolInvalidArgumentsObservation>): Record<string, unknown> {
  return {
    ok: false,
    observation,
    observation_kind: observation.kind,
    summary: observation.summary,
    model_visible_content: observation.modelVisibleContent,
  };
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
