import {
  retainToolEvidence,
  type ToolEvidenceRetentionContext,
} from "../context/tool-evidence-retention.ts";
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
  compactToolResultsBeforeNextModelCall?: boolean;
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
const CHECKPOINT_SINGLE_TOOL_RESULT_TOKENS = 6_000;
const CHECKPOINT_CUMULATIVE_TOOL_RESULT_TOKENS = 30_000;
const GENERIC_TOOL_RESULT_PREVIEW_TOKENS = 800;
const TOOL_RESULT_COMPACT_MARKER = "[...compacted tool result for context budget...]";
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

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function outputRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function compactStringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, limit);
}

function trimTextToTokenBudgetBalanced(text: string, maxTokens: number): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (estimateTokens(trimmed) <= maxTokens) return trimmed;
  const marker = `\n${TOOL_RESULT_COMPACT_MARKER}\n`;
  const maxChars = Math.max(80, Math.trunc(maxTokens) * 4 - marker.length);
  const headChars = Math.max(20, Math.floor(maxChars * 0.55));
  const tailChars = Math.max(20, maxChars - headChars);
  return [
    trimmed.slice(0, headChars).trimEnd(),
    marker.trim(),
    trimmed.slice(Math.max(0, trimmed.length - tailChars)).trimStart(),
  ].filter(Boolean).join("\n");
}

function compactGenericToolOutputForModel(input: {
  toolName: string;
  toolCallId?: string;
  output: unknown;
  reason: string;
  rawTokens: number;
  evidenceRetention?: ToolEvidenceRetentionContext;
}): unknown {
  const record = outputRecord(input.output);
  const source = typeof input.output === "string"
    ? input.output
    : JSON.stringify(input.output ?? null);
  const evidence = retainToolEvidence({
    context: input.evidenceRetention,
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    output: input.output,
    reason: input.reason,
    rawTokens: input.rawTokens,
  });
  const compact: Record<string, unknown> = {
    ok: record?.ok !== false,
    butler_tool_result_compacted: true,
    checkpoint_reason: input.reason,
    tool_name: input.toolName,
    raw_estimated_tokens: input.rawTokens,
    butler_evidence_packet: evidence.packet,
    preview: trimTextToTokenBudgetBalanced(source, GENERIC_TOOL_RESULT_PREVIEW_TOKENS),
  };
  for (const key of [
    "query",
    "title",
    "source_url",
    "final_url",
    "artifact_id",
    "artifact_label",
    "artifact_kind",
    "artifact_path",
    "row_count",
    "cache_hit",
  ]) {
    if (record?.[key] !== undefined) compact[key] = record[key];
  }
  const sourceUrls = compactStringList(record?.source_urls, 8);
  const artifactLabels = compactStringList(record?.artifact_labels, 8);
  if (sourceUrls.length > 0) compact.source_urls = sourceUrls;
  if (artifactLabels.length > 0) compact.artifact_labels = artifactLabels;
  if (record?.public_work_decision_context !== undefined) {
    compact.public_work_decision_context = record.public_work_decision_context;
  }
  return compact;
}

function compactToolOutputForModel(input: {
  toolName: string;
  toolCallId?: string;
  output: unknown;
  reason: string;
  rawTokens: number;
  evidenceRetention?: ToolEvidenceRetentionContext;
}): unknown {
  const record = outputRecord(input.output);
  if (!record || !Array.isArray(record.evidence_receipts)) {
    return compactGenericToolOutputForModel(input);
  }
  const evidence = retainToolEvidence({
    context: input.evidenceRetention,
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    output: input.output,
    reason: input.reason,
    rawTokens: input.rawTokens,
  });
  const sourceUrls = compactStringList(record.source_urls, 8);
  const recommendedReadUrls = compactStringList(record.recommended_read_urls, 6);
  const artifactLabels = compactStringList(record.artifact_labels, 8);
  const compact: Record<string, unknown> = {
    ok: record.ok !== false,
    butler_evidence_checkpoint: true,
    checkpoint_reason: input.reason,
    tool_name: input.toolName,
    raw_estimated_tokens: input.rawTokens,
    butler_evidence_packet: evidence.packet,
    evidence_receipts: record.evidence_receipts,
  };
  for (const key of [
    "query",
    "title",
    "source_url",
    "final_url",
    "artifact_id",
    "artifact_label",
    "artifact_kind",
    "row_count",
    "read_required",
    "read_reason",
    "cache_hit",
  ]) {
    if (record[key] !== undefined) compact[key] = record[key];
  }
  if (sourceUrls.length > 0) compact.source_urls = sourceUrls;
  if (recommendedReadUrls.length > 0) compact.recommended_read_urls = recommendedReadUrls;
  if (artifactLabels.length > 0) compact.artifact_labels = artifactLabels;
  if (record.public_work_decision_context !== undefined) {
    compact.public_work_decision_context = record.public_work_decision_context;
  }
  return compact;
}

function toolResultToMessage(input: {
  result: AgentLoopToolResult;
}): {
  message: AgentLoopMessage;
  estimatedTokens: number;
} {
  const content = JSON.stringify(input.result.ok ? { ok: true, output: input.result.output } : {
    ok: false,
    ...(input.result.output !== undefined
      ? { output: input.result.output }
      : { error: input.result.error ?? "unknown tool error" }),
  });
  return {
    message: {
      role: "tool",
      toolCallId: input.result.toolCallId,
      name: input.result.name,
      content,
    },
    estimatedTokens: estimateTokens(content),
  };
}

function compactObservedToolMessagesForFutureModelCalls(
  messages: AgentLoopMessage[],
  evidenceRetention?: ToolEvidenceRetentionContext,
): number {
  let totalTokens = 0;
  for (const message of messages) {
    if (message.role !== "tool") continue;
    const currentTokens = estimateTokens(message.content);
    const shouldCompactSingle = currentTokens >= CHECKPOINT_SINGLE_TOOL_RESULT_TOKENS;
    const shouldCompactCumulative =
      totalTokens + currentTokens >= CHECKPOINT_CUMULATIVE_TOOL_RESULT_TOKENS;
    if (!shouldCompactSingle && !shouldCompactCumulative) {
      totalTokens += currentTokens;
      continue;
    }
    const compacted = compactToolMessageContent({
      content: message.content,
      toolName: message.name ?? "tool",
      toolCallId: message.toolCallId,
      reason: shouldCompactSingle
        ? "single_tool_result_budget"
        : "cumulative_tool_result_budget",
      rawTokens: currentTokens,
      evidenceRetention,
    });
    message.content = compacted;
    totalTokens += estimateTokens(compacted);
  }
  return totalTokens;
}

function compactToolMessageContent(input: {
  content: string;
  toolName: string;
  toolCallId?: string;
  reason: string;
  rawTokens: number;
  evidenceRetention?: ToolEvidenceRetentionContext;
}): string {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(input.content) as Record<string, unknown>;
  } catch {
    // Invalid JSON cannot be safely compacted as a structured tool result.
  }
  if (parsed?.ok !== true) return input.content;
  const output = compactToolOutputForModel({
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    output: parsed.output,
    reason: input.reason,
    rawTokens: input.rawTokens,
    evidenceRetention: input.evidenceRetention,
  });
  const outputMetadata = outputRecord(output);
  const compactContent = JSON.stringify({ ok: true, output });
  const compactTokens = estimateTokens(compactContent);
  if (compactTokens >= input.rawTokens) return input.content;
  if (
    outputMetadata?.butler_evidence_checkpoint === true ||
    outputMetadata?.butler_tool_result_compacted === true
  ) {
    const checkpointKey = outputMetadata.butler_evidence_checkpoint === true
      ? "checkpoint_estimated_tokens"
      : "compact_estimated_tokens";
    outputMetadata[checkpointKey] = compactTokens;
    outputMetadata.estimated_saved_tokens = Math.max(0, input.rawTokens - compactTokens);
    return JSON.stringify({ ok: true, output });
  }
  return compactContent;
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
    });
    messages.push(toolMessage.message);
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
    if (input.compactToolResultsBeforeNextModelCall === true) {
      compactObservedToolMessagesForFutureModelCalls(messages, input.evidenceRetention);
    }
    emit(events, input.onEvent, { type: "model_call", iteration });
    const response = await input.callModel({
      messages,
      tools: input.tools,
      iteration,
    });
    if (input.compactToolResultsBeforeNextModelCall !== true) {
      compactObservedToolMessagesForFutureModelCalls(messages, input.evidenceRetention);
    }
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
