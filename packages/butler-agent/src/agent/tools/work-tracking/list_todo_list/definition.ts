import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const listTodoListToolDefinition = {
  type: "function",
  name: "list_todo_list",
  description: "Read Butler's durable checklist for the current work, including progress counts and the current in-progress item.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      list_id: {
        type: "string",
        description: "Safe list id. Defaults to main.",
      },
      include_completed: {
        type: "boolean",
        description: "When true, include completed and cancelled items.",
      },
    },
    required: [],
  },
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const listTodoListToolMetadata = {
  category: "todo",
  tags: [
    "todo",
    "progress",
    "checklist",
  ],
  safetyNotes: [
    "Use to inspect progress before updating or reporting it.",
  ],
  satisfiesCompletionObligations: [
    "source_verified",
  ],
} satisfies ToolCapabilityMetadata;
