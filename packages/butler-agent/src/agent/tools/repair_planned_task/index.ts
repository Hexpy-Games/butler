import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";

export const repairPlannedTaskToolDefinition = {
  type: "function",
  name: "repair_planned_task",
  description: "Start an autonomous repair worker for a failed or inconclusive planned task review when the repair policy allows it.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      task_id: {
        type: "string",
        description: "Planned task id to repair.",
      },
      repair_objective: {
        type: "string",
        description: "Specific repair objective. Defaults to the latest review recommendation.",
      },
      attempt: {
        type: "integer",
        description: "Review event attempt number when called from a hidden planned-review turn.",
      },
      worker_task_id: {
        type: "string",
        description: "Linked worker task id from the planned-review event.",
      },
      review_event_id: {
        type: "string",
        description: "Planned-review event id used to reject stale repair turns.",
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

export const repairPlannedTaskToolMetadata = {
  category: "dispatch",
  tags: [
    "planned",
    "repair",
    "retry",
  ],
  safetyNotes: [
    "Respect retry caps and critical-decision boundaries.",
  ],
} satisfies ToolCapabilityMetadata;
