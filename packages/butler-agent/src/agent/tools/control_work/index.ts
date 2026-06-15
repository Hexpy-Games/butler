import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";

export const controlWorkToolDefinition = {
  type: "function",
  name: "control_work",
  description: "Validate or perform a transport-neutral work control action: view a result, validate resume/cancel intent, or retry failed delivery.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: [
          "view_result",
          "resume",
          "retry_delivery",
          "cancel",
        ],
        description: "Control action to validate or execute.",
      },
      task_id: {
        type: "string",
        description: "Task id for view_result, resume, or cancel.",
      },
      notification_id: {
        type: "string",
        description: "Delivery notification id for retry_delivery.",
      },
    },
    required: [
      "action",
    ],
  },
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const controlWorkToolMetadata = {
  category: "work",
  tags: [
    "status",
    "resume",
    "cancel",
    "retry",
    "result",
  ],
  safetyNotes: [
    "Validates task state before returning a control intent.",
  ],
  satisfiesCompletionObligations: [
    "source_verified",
  ],
} satisfies ToolCapabilityMetadata;
