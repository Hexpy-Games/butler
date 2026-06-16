import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const getTaskResultToolDefinition = {
  type: "function",
  name: "get_task_result",
  description: "Read a Butler worker task status, result.md content, and observed worker log summary when result.md is absent or incomplete.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      task_id: {
        type: "string",
        description: "Task id from dispatch_worker or list_tasks.",
      },
    },
    required: [
      "task_id",
    ],
  },
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const getTaskResultToolMetadata = {
  category: "work",
  tags: [
    "tasks",
    "result",
    "status",
    "evidence",
  ],
  safetyNotes: [
    "Answer from durable evidence and respect reporting guards.",
  ],
  satisfiesCompletionObligations: [
    "source_verified",
  ],
} satisfies ToolCapabilityMetadata;
