import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const runPlannedTaskToolDefinition = {
  type: "function",
  name: "run_planned_task",
  description: "Start the worker attempt for an existing durable planned task. Use this only after create_planned_task has produced a plan.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      task_id: {
        type: "string",
        description: "Planned task id returned by create_planned_task.",
      },
    },
    required: [
      "task_id",
    ],
  },
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const runPlannedTaskToolMetadata = {
  category: "dispatch",
  tags: [
    "planned",
    "worker",
    "execute",
  ],
  safetyNotes: [
    "Starts planned work that must be reviewed before public reporting.",
  ],
} satisfies ToolCapabilityMetadata;
