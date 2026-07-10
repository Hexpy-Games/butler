import {
  retainToolEvidence,
  type ToolEvidenceRetentionContext,
} from "../../../agent/context/tool-evidence-retention.ts";
import { structuredToolResultModelPreview } from "../../../agent/turn/tool-result-model-preview.ts";
import {
  isWorkBlockToolExecutionResult,
  WORK_BLOCK_TOOL_NAME,
} from "../../../agent/turn/native/turn-runner/work-block-tool.ts";
import {
  estimateToolResultTokens,
  trimTextToTokenBudgetBalanced,
} from "./runtime-support.ts";

export const HOSTED_TOOL_RESULT_MAX_MODEL_TOKENS = 1_400;
export const HOSTED_OBSERVED_TOOL_CONTEXT_PRESSURE_TOKENS = 3_000;

interface HostedToolResultMessage {
  role: string;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string | Record<string, unknown> };
  }>;
}

export function hostedToolResultContent(input: {
  payload: Record<string, unknown>;
  toolName: string;
  toolCallId?: string;
  log: (line: string) => void;
  evidenceRetention?: ToolEvidenceRetentionContext;
}): string {
  if (input.toolName === WORK_BLOCK_TOOL_NAME && isWorkBlockToolExecutionResult(input.payload.output)) {
    return hostedWorkBlockResultContent(input);
  }
  const source = JSON.stringify(input.payload);
  const rawTokens = estimateToolResultTokens(source);
  if (rawTokens <= HOSTED_TOOL_RESULT_MAX_MODEL_TOKENS) return source;
  return compactHostedPayload({
    ...input,
    source,
    rawTokens,
    reason: "hosted_tool_result_budget",
  });
}

function hostedWorkBlockResultContent(input: {
  payload: Record<string, unknown>;
  toolName: string;
  toolCallId?: string;
  log: (line: string) => void;
  evidenceRetention?: ToolEvidenceRetentionContext;
}): string {
  const workBlock = input.payload.output;
  if (!isWorkBlockToolExecutionResult(workBlock)) return JSON.stringify(input.payload);
  const results = workBlock.results.map((result, index) => {
    const nestedPayload = result.ok
      ? { ok: true, output: result.output }
      : {
        ok: false,
        ...(result.error ? { error: result.error } : {}),
        ...(result.output !== undefined ? { output: result.output } : {}),
      };
    const content = hostedToolResultContent({
      payload: nestedPayload,
      toolName: result.name,
      toolCallId: `${input.toolCallId ?? "work-block"}:${index}`,
      log: input.log,
      evidenceRetention: input.evidenceRetention,
    });
    return {
      name: result.name,
      ok: result.ok,
      result: parsePayload(content) ?? nestedPayload,
    };
  });
  return JSON.stringify({
    ok: results.every((result) => result.ok),
    output: {
      butler_work_block_result: true,
      ...(workBlock.decision_feedback ? { decision_feedback: workBlock.decision_feedback } : {}),
      ...(workBlock.frontier ? { frontier: workBlock.frontier } : {}),
      results,
    },
  });
}

export function compactObservedHostedToolMessages(input: {
  messages: HostedToolResultMessage[];
  log: (line: string) => void;
  evidenceRetention?: ToolEvidenceRetentionContext;
}): number {
  const candidates = input.messages.flatMap((message) => {
    if (message.role !== "tool" || typeof message.content !== "string") return [];
    const parsed = parsePayload(message.content);
    if (!parsed || parsed.ok === false || isObservedCheckpoint(parsed)) return [];
    return [{ message, parsed, tokens: estimateToolResultTokens(message.content) }];
  });
  const totalTokens = candidates.reduce((sum, candidate) => sum + candidate.tokens, 0);
  if (totalTokens <= HOSTED_OBSERVED_TOOL_CONTEXT_PRESSURE_TOKENS) return 0;

  let savedTokens = 0;
  const compactedCallIds = new Set<string>();
  for (const candidate of candidates) {
    const compact = observedHostedCheckpoint({
      payload: candidate.parsed,
      source: candidate.message.content!,
      rawTokens: candidate.tokens,
      toolName: candidate.message.name ?? "tool",
      toolCallId: candidate.message.tool_call_id,
      log: input.log,
      evidenceRetention: input.evidenceRetention,
    });
    const compactTokens = estimateToolResultTokens(compact);
    if (compactTokens >= candidate.tokens) continue;
    candidate.message.content = compact;
    if (candidate.message.tool_call_id) compactedCallIds.add(candidate.message.tool_call_id);
    savedTokens += candidate.tokens - compactTokens;
  }
  compactObservedAssistantCalls(input.messages, compactedCallIds);
  return savedTokens;
}

function observedHostedCheckpoint(input: {
  payload: Record<string, unknown>;
  source: string;
  rawTokens: number;
  toolName: string;
  toolCallId?: string;
  log: (line: string) => void;
  evidenceRetention?: ToolEvidenceRetentionContext;
}): string {
  const prior = record(input.payload.output);
  const priorPacket = record(prior?.butler_evidence_packet);
  const output = input.payload.ok === true ? input.payload.output : input.payload;
  const evidence = priorPacket
    ? { packet: priorPacket }
    : retainToolEvidence({
      context: input.evidenceRetention,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      output,
      reason: "hosted_observed_round_context_pressure",
      rawTokens: input.rawTokens,
    });
  const preview = prior?.preview ?? structuredToolResultModelPreview({
    toolName: input.toolName,
    output,
  }) ?? { tool_name: input.toolName, ok: input.payload.ok !== false };
  const packet = evidence.packet;
  const compact = JSON.stringify({
    ok: input.payload.ok !== false,
    output: {
      butler_tool_result_observed_checkpoint: true,
      tool_name: input.toolName,
      raw_estimated_tokens: finiteNumber(prior?.raw_estimated_tokens) ?? input.rawTokens,
      evidence_ref: {
        artifact_id: text(packet.artifact_id),
        digest: text(packet.digest),
        tool: text(record(packet.rehydrate)?.tool) ?? "read_tool_evidence_artifact",
      },
      preview,
    },
  });
  input.log(
    `tool ${input.toolName} result checkpointed after model observation: raw_tokens=${input.rawTokens} checkpoint_tokens=${estimateToolResultTokens(compact)}`,
  );
  return compact;
}

function compactObservedAssistantCalls(
  messages: HostedToolResultMessage[],
  compactedCallIds: ReadonlySet<string>,
): void {
  if (compactedCallIds.size === 0) return;
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      if (!compactedCallIds.has(call.id)) continue;
      call.function.arguments = JSON.stringify(compactObservedArguments(call.function.arguments));
    }
  }
}

function compactObservedArguments(value: string | Record<string, unknown>): Record<string, unknown> {
  const parsed = typeof value === "string" ? parsePayload(value) : value;
  if (!parsed) return { butler_observed_call: true };
  if (Array.isArray(parsed.calls)) {
    return compactObservedWorkBlockArguments(parsed);
  }
  if (record(parsed.decision) && record(parsed.args)) {
    return compactObservedSingleWorkBlockArguments(parsed);
  }
  return compactObservedCallArguments(parsed);
}

function compactObservedSingleWorkBlockArguments(
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  return {
    butler_observed_call: true,
    argument_keys: Object.keys(parsed).slice(0, 24),
    decision: selectCompactArguments(record(parsed.decision)!, [
      "block_title", "objective", "next_step", "expected_effect", "repeat_reason",
    ]),
    args: selectCompactArguments(record(parsed.args)!, [
      "kind", "id", "title", "status", "work_id", "task_id", "path", "pattern", "query",
      "start_line", "limit_lines", "validation_suite", "output_mode",
    ]),
  };
}

function compactObservedWorkBlockArguments(
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  const decision = record(parsed.decision);
  const calls = parsed.calls as unknown[];
  return {
    butler_observed_call: true,
    argument_keys: Object.keys(parsed).slice(0, 24),
    ...(decision
      ? {
        decision: selectCompactArguments(decision, [
          "block_title", "objective", "next_step", "expected_effect", "repeat_reason",
        ]),
      }
      : {}),
    calls: calls.slice(0, 6).flatMap((value) => {
      const call = record(value);
      if (!call) return [];
      const args = record(call.args);
      return [{
        ...(text(call.name) ? { name: text(call.name) } : {}),
        ...(args
          ? {
            args: selectCompactArguments(args, [
              "kind", "id", "title", "status", "work_id", "task_id", "path", "pattern",
              "query", "start_line", "limit_lines", "validation_suite", "output_mode",
            ]),
          }
          : {}),
      }];
    }),
  };
}

function compactObservedCallArguments(parsed: Record<string, unknown>): Record<string, unknown> {
  const preferredKeys = [
    "kind", "id", "title", "status", "work_id", "task_id", "path", "pattern", "query",
    "block_title", "objective", "next_step", "expected_effect", "repeat_reason",
    "start_line", "limit_lines", "validation_suite", "output_mode",
  ];
  const selected = selectCompactArguments(parsed, preferredKeys);
  return {
    butler_observed_call: true,
    argument_keys: Object.keys(parsed).slice(0, 24),
    ...selected,
  };
}

function selectCompactArguments(
  parsed: Record<string, unknown>,
  preferredKeys: readonly string[],
): Record<string, string | number | boolean | null> {
  return Object.fromEntries(preferredKeys.flatMap((key) => {
    const compact = compactArgumentValue(parsed[key]);
    return compact === undefined ? [] : [[key, compact]];
  }));
}

function compactArgumentValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 237)}...`;
}

function compactHostedPayload(input: {
  payload: Record<string, unknown>;
  source: string;
  rawTokens: number;
  toolName: string;
  toolCallId?: string;
  log: (line: string) => void;
  evidenceRetention?: ToolEvidenceRetentionContext;
  reason: "hosted_tool_result_budget" | "hosted_observed_round_context_pressure";
}): string {
  const output = input.payload.ok === true ? input.payload.output : input.payload;
  const evidence = retainToolEvidence({
    context: input.evidenceRetention,
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    output,
    reason: input.reason,
    rawTokens: input.rawTokens,
  });
  const structuredPreview = structuredToolResultModelPreview({
    toolName: input.toolName,
    output,
  });
  const preview = structuredPreview
    ? structuredPreview
    : trimTextToTokenBudgetBalanced(
      input.source,
      Math.max(200, HOSTED_TOOL_RESULT_MAX_MODEL_TOKENS - 180),
    );
  const compact = JSON.stringify({
    ok: input.payload.ok !== false,
    output: {
      butler_tool_result_compacted: true,
      tool_name: input.toolName,
      compaction_reason: input.reason,
      raw_estimated_tokens: input.rawTokens,
      compact_estimated_tokens: estimateToolResultTokens(JSON.stringify(preview)),
      butler_evidence_packet: evidence.packet,
      preview,
    },
  });
  input.log(
    `tool ${input.toolName} result compacted for hosted context: reason=${input.reason} raw_tokens=${input.rawTokens} compact_tokens=${estimateToolResultTokens(compact)}`,
  );
  return compact;
}

function parsePayload(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isObservedCheckpoint(payload: Record<string, unknown>): boolean {
  const output = payload.output;
  return Boolean(
    output && typeof output === "object" && !Array.isArray(output) &&
    (output as Record<string, unknown>).butler_tool_result_observed_checkpoint === true,
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
