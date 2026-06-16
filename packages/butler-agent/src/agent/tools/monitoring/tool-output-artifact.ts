import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";

export const readToolOutputArtifactToolDefinition = {
  type: "function",
  name: "read_tool_output_artifact",
  description: "Read a bounded stdout/stderr slice from a Butler-owned tool-output artifact by artifact id or artifact path. Use this when a compact tool preview is insufficient.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      artifact_id: {
        type: "string",
        description: "Artifact id from a compacted tool-output preview.",
      },
      path: {
        type: "string",
        description: "Absolute artifact path under Butler's tool-output artifact root.",
      },
      stream: {
        type: "string",
        enum: [
          "stdout",
          "stderr",
          "both",
        ],
        description: "Which stream to read. Defaults to both.",
      },
      offset_lines: {
        type: "integer",
        description: "Zero-based starting line. Defaults to 0.",
      },
      limit_lines: {
        type: "integer",
        description: "Maximum lines to return. Defaults to 80.",
      },
      max_tokens: {
        type: "integer",
        description: "Maximum estimated tokens to return. Defaults to 1200.",
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
    "Reads only bounded slices of Butler-owned artifacts; avoid dumping full raw output.",
  ],
  satisfiesCompletionObligations: [
    "source_verified",
  ],
} satisfies ToolCapabilityMetadata;
