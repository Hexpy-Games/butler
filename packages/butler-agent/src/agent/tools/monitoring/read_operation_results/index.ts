import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";
import type { ButlerToolExecutorRegistry } from "../../butler-tools.ts";

export const OPERATION_RESULT_EXACT_READ_MAX_BYTES = 4 * 1024;

export const readOperationResultsToolDefinition: ButlerToolDefinition = {
  type: "function",
  name: "read_operation_results",
  description: "Read one bounded byte range from an exact durable operation result.",
  parameters: {
    type: "object", additionalProperties: false,
    properties: {
      result_ref: { type: "string", minLength: 1, maxLength: 256 },
      sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      revision: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
      work_id: { anyOf: [{ type: "string", minLength: 1, maxLength: 256 }, { type: "null" }] },
      offset: { type: "integer", minimum: 0 },
      length: { type: "integer", minimum: 1, maximum: OPERATION_RESULT_EXACT_READ_MAX_BYTES },
    },
    required: ["result_ref", "sha256", "revision", "work_id", "offset", "length"],
  },
  effectBoundary: "none", concurrencySafe: true,
  interruptBehavior: "cancel", transcriptVisibility: "visible",
};

export const readOperationResultsToolMetadata: ToolCapabilityMetadata = {
  category: "monitoring",
  tags: ["read", "durable-result", "exact-range"],
  safetyNotes: ["Requires a turn-scoped exact-result capability."],
};

export function createReadOperationResultsHandler(
  read?: (args: Record<string, unknown>) => unknown,
): ButlerToolExecutorRegistry {
  return {
    [readOperationResultsToolDefinition.name]: (call) => {
      if (!read) throw new Error("operation_result_exact_read_dependency_missing");
      return read(call.args);
    },
  };
}
