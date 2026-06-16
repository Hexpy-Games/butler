import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const listTasksToolDefinition = {
  type: "function",
  name: "list_tasks",
  description: "List recent Butler worker tasks and their statuses.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: {
        type: "integer",
        description: "Maximum number of recent tasks to return.",
      },
    },
    required: [],
  },
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const listTasksToolMetadata = {
  category: "work",
  tags: [
    "tasks",
    "status",
    "workers",
  ],
  safetyNotes: [
    "Use mode/safety fields before reporting task outcomes.",
  ],
  satisfiesCompletionObligations: [
    "source_verified",
  ],
} satisfies ToolCapabilityMetadata;
