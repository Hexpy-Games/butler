import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";

export const listAutomationsToolDefinition = {
  type: "function",
  name: "list_automations",
  description: "List native Butler automations with prompt previews, schedule, next run, and run counts.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      include_deleted: {
        type: "boolean",
      },
    },
    required: [],
  },
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const listAutomationsToolMetadata = {
  category: "automation",
  tags: [
    "schedule",
    "automation",
    "list",
  ],
  safetyNotes: [
    "Returns prompt previews, not full private prompts.",
  ],
  satisfiesCompletionObligations: [
    "source_verified",
  ],
} satisfies ToolCapabilityMetadata;
