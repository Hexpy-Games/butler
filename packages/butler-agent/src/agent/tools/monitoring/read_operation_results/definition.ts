import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const OPERATION_RESULT_EXACT_READ_MAX_BYTES = 4 * 1024;

export const readOperationResultsToolDefinition = {
  type: "function",
  name: "read_operation_results",
  description: "Read one bounded byte range from an exact durable operation result.",
  parameters: {
    type: "object",
    additionalProperties: false,
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
