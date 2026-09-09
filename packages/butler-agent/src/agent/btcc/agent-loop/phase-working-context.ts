import type { ModelRoundMessage, ModelRoundToolCall } from "../ports/model-round.ts";
import { normalizeGuidedToolCall } from "../../tools/tool-call-normalization.ts";

const TARGET_KEYS = new Set([
  "path", "paths", "pattern", "query", "command", "url", "start_line",
  "end_line", "artifact_id", "offset", "limit", "project_ref", "work_ref",
]);
const RESULT_KEYS = new Set([
  "ok", "status", "state", "path", "pattern", "query", "exit_code",
  "timed_out", "summary", "message", "candidate_paths", "match_count",
  "files_read", "files_requested", "next_cursor", "next_start_line",
  "truncated", "butler_tool_artifact", "error",
]);

/** Small semantic memory for a completed call; exact output stays in its reader/store. */
export function phaseWorkingContext(
  call: ModelRoundToolCall,
  result: ModelRoundMessage,
): Record<string, unknown> {
  const normalized = normalizeGuidedToolCall({ toolName: call.name,
    args: parseRecord(call.rawArguments) ?? {} });
  return {
    target: select(normalized.args, TARGET_KEYS, 0),
    outcome: select(parseRecord(result.content), RESULT_KEYS, 0),
  };
}

function select(
  value: Record<string, unknown> | undefined,
  allowed: ReadonlySet<string>,
  depth: number,
): Record<string, unknown> {
  if (!value || depth > 3) return {};
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (allowed.has(key)) {
      const projected = compactValue(item, depth + 1);
      if (projected !== undefined) result[key] = projected;
      continue;
    }
    if (key === "request" || key === "input") {
      const nested = select(asRecord(item), allowed, depth + 1);
      if (Object.keys(nested).length > 0) result[key] = nested;
      continue;
    }
    if (key === "requests" && Array.isArray(item)) {
      const nested = item.slice(0, 8)
        .map((entry) => select(asRecord(entry), allowed, depth + 1))
        .filter((entry) => Object.keys(entry).length > 0);
      if (nested.length > 0) result.requests = nested;
      continue;
    }
    if (key === "output" || key === "result") {
      Object.assign(result, select(asRecord(item), allowed, depth + 1));
    }
  }
  return result;
}

function compactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return bounded(value, 320);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (depth > 3) return undefined;
  if (Array.isArray(value)) return value.slice(0, 8).map((entry) => compactValue(entry, depth + 1));
  const record = asRecord(value);
  if (!record) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === "stack" || key === "content" || key === "stdout" || key === "stderr") continue;
    const projected = compactValue(entry, depth + 1);
    if (projected !== undefined) result[key] = projected;
  }
  return result;
}

function parseRecord(value: string): Record<string, unknown> | undefined {
  try { return asRecord(JSON.parse(value)); } catch { return undefined; }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
