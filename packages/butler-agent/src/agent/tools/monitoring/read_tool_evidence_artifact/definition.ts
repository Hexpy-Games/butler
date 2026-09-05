import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const readToolEvidenceArtifactToolDefinition = {
  type: "function",
  name: "read_tool_evidence_artifact",
  description: "Read original saved tool evidence. Continue exactly by passing next_offset_chars as offset_chars; whitespace and line endings are preserved.",
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
      offset_lines: {
        type: "integer",
        description: "Zero-based starting line; ignored when offset_chars is supplied.",
      },
      offset_chars: {
        type: "integer",
        minimum: 0,
        description: "Exact UTF-16 character offset from next_offset_chars, including within a long line.",
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
  effectBoundary: "none",
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const readToolEvidenceArtifactToolMetadata = {
  category: "monitoring",
  tags: [
    "tool",
    "artifact",
    "evidence",
    "slice",
    "debug",
  ],
  safetyNotes: [
    "Reads only bounded slices of Butler-owned tool evidence.",
  ],
} satisfies ToolCapabilityMetadata;
