import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const readToolOutputArtifactToolDefinition = {
  type: "function",
  name: "read_tool_output_artifact",
  description: "Read a bounded stdout/stderr slice from a Butler tool-output artifact.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      artifact_id: {
        type: "string",
      },
      path: {
        type: "string",
      },
      stream: {
        type: "string",
        enum: [
          "stdout",
          "stderr",
          "both",
        ],
      },
      offset_lines: {
        type: "integer",
      },
      limit_lines: {
        type: "integer",
      },
      max_tokens: {
        type: "integer",
      },
    },
    required: [],
  },
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const readToolOutputArtifactToolMetadata = {
  category: "monitoring",
  tags: [
    "tool",
    "artifact",
    "stdout",
    "stderr",
    "slice",
    "debug",
  ],
  safetyNotes: [
    "Reads only bounded slices of Butler-owned tool output.",
  ],
  satisfiesCompletionObligations: [
    "source_verified",
  ],
} satisfies ToolCapabilityMetadata;
