import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const OPERATION_RESULT_EXACT_READ_MAX_BYTES = 4 * 1024;

export const readOperationResultsToolDefinition = {
  type: "function",
  name: "read_operation_results",
  description: "Read an exact stored result or its original request (source=request). Find references with list_operation_results. Decode data from base64; continue at nextOffset until null. The last page may be shorter.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      source: { type: "string", enum: ["request", "result"] },
      result_ref: { type: "string", minLength: 1, maxLength: 256 },
      sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      revision: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
      work_id: { anyOf: [{ type: "string", minLength: 1, maxLength: 256 }, { type: "null" }] },
      offset: { type: "integer", minimum: 0 },
      length: { type: "integer", minimum: 1, maximum: OPERATION_RESULT_EXACT_READ_MAX_BYTES },
    },
    required: ["result_ref", "sha256", "revision", "work_id", "offset", "length"],
  },
  effectBoundary: "none",
  concurrencySafe: true,
  interruptBehavior: "cancel",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const readOperationResultsToolMetadata = {
  category: "monitoring",
  tags: ["read", "durable-result", "exact-range"],
  safetyNotes: ["Requires a turn-scoped exact-result capability."],
} satisfies ToolCapabilityMetadata;

export const listOperationResultsToolDefinition = {
  type: "function", name: "list_operation_results",
  description: "Find prior tool requests/results in this Turn and its existing Work without repeating the operation. Start with cursor=0 and through=null. Search a literal substring of request text (not separate keywords); leave query empty to filter only by tool/status. Use returned exact_read with read_operation_results. Continue with next_cursor and the returned through watermark; request previews may be shortened, originals remain readable.",
  parameters: { type: "object", additionalProperties: false, properties: {
    query: { type: "string", maxLength: 500 }, tool_name: { type: "string" },
    status: { anyOf: [{ type: "string", enum: ["completed", "failed", "cancelled"] }, { type: "null" }], description: "Operation outcome: completed means success, failed includes returned tool errors, nonzero exit codes and timeouts; cancelled means cancelled execution. null searches all outcomes." },
    cursor: { type: "integer", minimum: 0 },
    through: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }], description: "null for the first page; thereafter copy through from the previous page." },
    limit: { type: "integer", minimum: 1, maximum: 10 },
  }, required: [] },
  effectBoundary: "none", concurrencySafe: true, interruptBehavior: "cancel", transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;
