/** Result formatting is lossless; the request serializer alone owns size limits. */
import { artifactResultPreview, operationResultPagePreview } from "./artifact-result-preview.ts";
import { record } from "./preview-values.ts";

const WORK_RESULT_TOOL_NAMES = new Set([
  "start_work", "continue_work", "replace_work_plan", "record_work_checkpoint",
  "record_work_review", "record_work_disposition",
]);

export interface ToolResultModelPreviewContext {
  seenPublicWebEvidenceItemIds: Set<string>;
  seenProviderOverviews: Set<string>;
  resultBatchBudget?: { remainingBytes: number; remainingResults: number };
}

export type StructuredToolResultModelProjection = {
  preview: Record<string, unknown> | null;
  partial: boolean;
};

export function structuredToolResultModelPreview(input: {
  toolName: string;
  output: unknown;
  seenPublicWebEvidenceItemIds?: Set<string>;
  context?: ToolResultModelPreviewContext;
}): Record<string, unknown> | null {
  return structuredToolResultModelProjection(input).preview;
}

export function structuredToolResultModelProjection(input: {
  toolName: string;
  output: unknown;
  seenPublicWebEvidenceItemIds?: Set<string>;
  context?: ToolResultModelPreviewContext;
}): StructuredToolResultModelProjection {
  const { toolName } = input;
  const output = toolPayload(input.output, payloadKeys(toolName));
  if (!output) {
    return { preview: input.output === undefined ? null : {
      tool_name: toolName,
      [typeof input.output === "string" ? "text" : "value"]: input.output,
    }, partial: false };
  }
  // Work receipts deliberately expose only their existing public control facts.
  if (WORK_RESULT_TOOL_NAMES.has(toolName)) {
    return { preview: workResultPreview(toolName, output), partial: false };
  }
  if (toolName === "read_operation_results" && typeof output.data === "string") {
    return { preview: operationResultPagePreview(output), partial: false };
  }
  if (toolName === "read_tool_output_artifact" || toolName === "read_tool_evidence_artifact") {
    return { preview: artifactResultPreview(toolName, output), partial: false };
  }
  if (toolName === "web_search" || toolName === "web_read") {
    // Cache hits and repeated requests still return the requested public body.
    const { public_web_evidence_items: items, markdown, ...facts } = output;
    delete facts.evidence_receipts;
    delete facts.evidence_capability_receipts;
    const error = record(facts.error);
    if (error) facts.error = select(error, ["code", "message"]);
    const coverage = record(facts.coverage_budget);
    if (coverage) facts.coverage_budget = select(coverage, ["result_count", "stop_reason"]);
    return { preview: {
      tool_name: toolName, ...facts,
      ...(typeof markdown === "string" ? { page_excerpt: markdown } : {}),
      ...(Array.isArray(facts.failed_queries) ? { failed_query_count: facts.failed_queries.length } : {}),
      ...(Array.isArray(items) ? { evidence_items: items, evidence_item_count: items.length } : {}),
    }, partial: false };
  }
  if (toolName === "read_conversation_context") {
    const { runtime_session_id: _runtimeSessionId, ...publicContext } = output;
    return { preview: { tool_name: toolName, ...publicContext }, partial: false };
  }
  if (toolName === "grep_files") {
    const matches = Array.isArray(output.matches) ? output.matches : [];
    return { preview: { tool_name: toolName, ...output,
      match_count: matches.length,
      candidate_paths: [...new Set(matches.flatMap((value) => {
        const path = record(value)?.path;
        return typeof path === "string" ? [path] : [];
      }))],
    }, partial: false };
  }
  return { preview: { tool_name: toolName, ...output }, partial: false };
}

function payloadKeys(toolName: string): string[] {
  if (WORK_RESULT_TOOL_NAMES.has(toolName)) return ["work", "error"];
  switch (toolName) {
    case "read_file": return ["files"];
    case "grep_files": return ["matches", "pattern"];
    case "read_conversation_context": return ["messages", "summaries"];
    case "run_command": return ["model_visible_content", "exit_code"];
    case "web_search": case "web_read": return ["public_web_evidence_items"];
    case "read_operation_results": return ["encoding", "data", "offset"];
    case "read_tool_output_artifact": return ["stdout", "stderr"];
    case "read_tool_evidence_artifact": return ["text", "artifact"];
    default: return [];
  }
}

function workResultPreview(toolName: string, output: Record<string, unknown>): Record<string, unknown> {
  const work = record(output.work);
  return {
    tool_name: toolName,
    ...select(output, ["ok", "status", "authority_pending", "executed", "not_executed",
      "pending", "queued", "exit_code", "timed_out", "error"]),
    ...(work ? { work: {
      ...select(work, ["work_id", "status", "current_stage", "execution_mode",
        "allowed_next_stages", "unresolved_action_keys", "completion_blockers",
        "latest_plan_review", "latest_result_review", "latest_completion_validation", "latest_disposition"]),
      actions: Array.isArray(work.actions) ? work.actions.flatMap((entry) => {
        const action = record(entry);
        return action ? [select(action, ["action_key", "status"])] : [];
      }) : [],
    } } : {}),
  };
}

function select(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
}

function toolPayload(value: unknown, keys: readonly string[], depth = 0): Record<string, unknown> | null {
  const object = record(value);
  if (!object || keys.length === 0 || keys.some((key) => key in object) || depth >= 3) return object;
  for (const key of ["result", "output"]) {
    const nested = toolPayload(object[key], keys, depth + 1);
    if (nested && keys.some((expected) => expected in nested)) return nested;
  }
  return object;
}
