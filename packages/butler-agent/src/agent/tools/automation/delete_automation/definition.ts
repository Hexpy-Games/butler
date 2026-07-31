import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const deleteAutomationToolDefinition = {
  type: "function",
  name: "delete_automation",
  description: "Mark a native Butler automation as deleted.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: {
        type: "string",
        description: "Automation id.",
      },
    },
    required: [
      "id",
    ],
  },
  effectBoundary: "reviewed_persistent",
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const deleteAutomationToolMetadata = {
  category: "automation",
  tags: [
    "schedule",
    "automation",
    "delete",
  ],
  safetyNotes: [
    "Deletes by id; inspect existing automations first when unsure.",
  ],
} satisfies ToolCapabilityMetadata;
