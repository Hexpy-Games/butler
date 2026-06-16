import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";

export const updateExplicitMemoryToolDefinition = {
  type: "function",
  name: "update_explicit_memory",
  description: "Write an explicit durable rule memory with provenance. Use only for user corrections, explicit preferences, or durable instructions.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: {
        type: "string",
        enum: [
          "rule",
        ],
        description: "Memory destination.",
      },
      text: {
        type: "string",
        description: "Explicit memory text.",
      },
      source: {
        type: "string",
        description: "Provenance summary, e.g. user correction message id.",
      },
    },
    required: [
      "kind",
      "text",
      "source",
    ],
  },
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const updateExplicitMemoryToolMetadata = {
  category: "memory",
  tags: [
    "memory",
    "rules",
    "preference",
  ],
  safetyNotes: [
    "Use only for explicit user preferences or rules with provenance.",
  ],
} satisfies ToolCapabilityMetadata;
