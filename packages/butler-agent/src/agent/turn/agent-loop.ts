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
const GENERIC_TOOL_RESULT_PREVIEW_TOKENS = 1_200;
const TOOL_RESULT_COMPACT_MARKER = "[...compacted tool result for context budget...]";

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
  output: unknown;
  reason: string;
  rawTokens: number;
}): unknown {
  const record = outputRecord(input.output);
  const source = typeof input.output === "string"
    ? input.output
    : JSON.stringify(input.output ?? null);
  const compact: Record<string, unknown> = {
    ok: record?.ok !== false,
    butler_tool_result_compacted: true,
    checkpoint_reason: input.reason,
    tool_name: input.toolName,
    raw_estimated_tokens: input.rawTokens,
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
  output: unknown;
  reason: string;
  rawTokens: number;
}): unknown {
  const record = outputRecord(input.output);
  if (!record || !Array.isArray(record.evidence_receipts)) {
    return compactGenericToolOutputForModel(input);
  }
  const sourceUrls = compactStringList(record.source_urls, 8);
  const recommendedReadUrls = compactStringList(record.recommended_read_urls, 6);
  const artifactLabels = compactStringList(record.artifact_labels, 8);
  const compact: Record<string, unknown> = {
    ok: record.ok !== false,
    butler_evidence_checkpoint: true,
    checkpoint_reason: input.reason,
    tool_name: input.toolName,
    raw_estimated_tokens: input.rawTokens,
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
  cumulativeToolResultTokens: number;
}): {
  message: AgentLoopMessage;
  estimatedTokens: number;
} {
  const rawContent = JSON.stringify(input.result.ok ? { ok: true, output: input.result.output } : {
    ok: false,
    error: input.result.error ?? "unknown tool error",
  });
  const rawTokens = estimateTokens(rawContent);
  const shouldCheckpoint = input.result.ok && (
    rawTokens >= CHECKPOINT_SINGLE_TOOL_RESULT_TOKENS ||
    input.cumulativeToolResultTokens + rawTokens >= CHECKPOINT_CUMULATIVE_TOOL_RESULT_TOKENS
  );
  let content = rawContent;
  if (shouldCheckpoint) {
    const output = compactToolOutputForModel({
      toolName: input.result.name,
      output: input.result.output,
      reason: rawTokens >= CHECKPOINT_SINGLE_TOOL_RESULT_TOKENS
        ? "single_tool_result_budget"
        : "cumulative_tool_result_budget",
      rawTokens,
    });
    const outputMetadata = outputRecord(output);
    const checkpointTokens = estimateTokens(JSON.stringify({ ok: true, output }));
    if (checkpointTokens < rawTokens) {
      if (
        outputMetadata?.butler_evidence_checkpoint === true ||
        outputMetadata?.butler_tool_result_compacted === true
      ) {
        const checkpointKey = outputMetadata.butler_evidence_checkpoint === true
          ? "checkpoint_estimated_tokens"
          : "compact_estimated_tokens";
        outputMetadata[checkpointKey] = checkpointTokens;
        outputMetadata.estimated_saved_tokens = Math.max(0, rawTokens - checkpointTokens);
      }
      content = JSON.stringify({ ok: true, output });
    } else if (outputMetadata?.butler_evidence_checkpoint === true) {
      outputMetadata.checkpoint_estimated_tokens = checkpointTokens;
      outputMetadata.estimated_saved_tokens = Math.max(0, rawTokens - checkpointTokens);
    }
  }
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

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopOutput> {
  const messages = [...input.messages];
  const events: AgentLoopEvent[] = [];
  const maxIterations = Math.max(1, input.maxIterations ?? DEFAULT_MAX_ITERATIONS);
  const toolResults: AgentLoopToolResult[] = [];
  let cumulativeToolResultTokens = 0;

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
      return {
        finalText: finalText || "",
        messages,
        events,
        stoppedByLimit: false,
      };
    }

    await input.onAssistantTextBeforeTools?.({
      text: response.text?.trim() ?? "",
      toolCalls: calls,
      iteration,
    });

    for (const call of calls) {
      emit(events, input.onEvent, {
        type: "tool_call",
        iteration,
        toolCall: call,
      });
      const tool = input.tools.find((candidate) => candidate.name === call.name);
      const validationError = validateToolInput(tool, call);
      const result: AgentLoopToolResult = validationError
        ? {
            toolCallId: call.id,
            name: call.name,
            ok: false,
            error: validationError,
          }
        : await input.executeTool(call).then(
            (output): AgentLoopToolResult => ({
              toolCallId: call.id,
              name: call.name,
              ok: true,
              output,
            }),
            (error): AgentLoopToolResult => ({
              toolCallId: call.id,
              name: call.name,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
      );
      toolResults.push(result);
      const toolMessage = toolResultToMessage({
        result,
        cumulativeToolResultTokens,
      });
      cumulativeToolResultTokens += toolMessage.estimatedTokens;
      messages.push(toolMessage.message);
      emit(events, input.onEvent, {
        type: "tool_result",
        iteration,
        toolResult: result,
      });
      if (result.ok) {
        const finalText = (await input.finalTextFromToolResult?.({
          toolCall: call,
          toolResult: result,
        }))?.trim();
        if (finalText) {
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
        }
      }
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
