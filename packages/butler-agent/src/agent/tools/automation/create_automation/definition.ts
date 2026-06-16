import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const createAutomationToolDefinition = {
  type: "function",
  name: "create_automation",
  description: "Create a native Butler automation: a one-shot or interval scheduled prompt routed back into a Butler session.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: {
        type: "string",
        description: "Optional safe automation id.",
      },
      title: {
        type: "string",
        description: "Short user-facing title.",
      },
      prompt: {
        type: "string",
        description: "Prompt to run when the automation fires.",
      },
      session_id: {
        type: "string",
        description: "Target session id. Defaults to active session.",
      },
      schedule_type: {
        type: "string",
        enum: [
          "once",
          "interval",
        ],
      },
      run_at: {
        type: "string",
        description: "ISO timestamp for one-shot automations.",
      },
      interval_minutes: {
        type: "number",
        description: "Interval in minutes for recurring automations.",
      },
      start_at: {
        type: "string",
        description: "Optional ISO start timestamp for interval automations.",
      },
    },
    required: [
      "prompt",
      "schedule_type",
    ],
  },
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const createAutomationToolMetadata = {
  category: "automation",
  tags: [
    "schedule",
    "automation",
    "reminder",
    "recurring",
    "자동화",
    "예약",
    "알림",
  ],
  safetyNotes: [
    "Confirm critical or costly recurring actions before scheduling.",
  ],
} satisfies ToolCapabilityMetadata;
