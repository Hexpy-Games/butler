import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const readToolEvidenceArtifactToolDefinition = {
  type: "function",
  name: "read_tool_evidence_artifact",
  description: "Read a bounded slice from a Butler tool-evidence artifact.",
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
  satisfiesCompletionObligations: [
    "source_verified",
  ],
} satisfies ToolCapabilityMetadata;
