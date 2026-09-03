import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const readToolOutputArtifactToolDefinition = {
  type: "function",
  name: "read_tool_output_artifact",
  description: "Read or search the original saved stdout/stderr without rerunning the command. For exact continuation select one stream and pass its next_offset_chars as offset_chars, omitting search. Text preserves whitespace and line endings; offsets count UTF-16 characters.",
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
        minimum: 0,
        description: "Zero-based starting line; ignored when offset_chars is supplied.",
      },
      offset_chars: {
        type: "integer",
        minimum: 0,
        description: "Exact zero-based UTF-16 character offset, including within a long line. Use the selected stream's next_offset_chars for lossless continuation.",
      },
      search: {
        type: "string",
        minLength: 1,
        description: "Case-sensitive literal substring. Return a slice beginning at the first match at or after the offset; search metadata reports no match explicitly.",
      },
      limit_lines: {
        type: "integer",
        description: "Line budget, default 80, applied range 1-500; actual limits are returned.",
      },
      max_tokens: {
        type: "integer",
        description: "Combined estimated text-token budget, default 1200, applied range 50-8000; actual and per-stream budgets are returned.",
      },
    },
    required: [],
  },
  effectBoundary: "none",
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
