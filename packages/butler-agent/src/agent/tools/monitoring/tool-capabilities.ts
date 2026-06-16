import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";

export const listToolCapabilitiesToolDefinition = {
  type: "function",
  name: "list_tool_capabilities",
  description: "List Butler's available and disabled native tools with categories, safety notes, and disabled reasons.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      category: {
        type: "string",
        description: "Optional category filter.",
      },
      include_disabled: {
        type: "boolean",
        description: "Whether to include disabled tools. Defaults to true.",
      },
    },
    required: [],
  },
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const listToolCapabilitiesToolMetadata = {
  category: "control",
  tags: [
    "tools",
    "capabilities",
    "available",
    "disabled",
  ],
  safetyNotes: [
    "Discovery only; does not execute the listed tools.",
  ],
  satisfiesCompletionObligations: [
    "source_verified",
  ],
} satisfies ToolCapabilityMetadata;
