import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const updateWorkStreamStateToolDefinition = {
  type: "function",
  name: "update_work_stream_state",
  description: "Advance or pause the active Butler-owned WorkStream through the issue-level state machine. Use for waiting_user, paused, recoverable, and explicit review/reporting transitions.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      work_stream_id: {
        type: "string",
        description: "Optional work stream id. Defaults to the active stream for this session.",
      },
      state: {
        type: "string",
        enum: [
          "routing",
          "conception",
          "planning",
          "executing",
          "reviewing",
          "consolidating",
          "reporting",
          "waiting_user",
          "paused",
          "complete",
          "failed",
          "recoverable",
          "cancelled",
        ],
      },
      active_step_id: {
        type: "string",
        description: "Optional active step id when the state points to a known todo step.",
      },
      status_note: {
        type: "string",
        description: "Short public-safe status note. Do not include hidden reasoning or raw private text.",
      },
    },
    required: [
      "state",
    ],
  },
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const updateWorkStreamStateToolMetadata = {
  category: "work",
  tags: [
    "workstream",
    "fsm",
    "state",
    "pause",
    "resume",
    "review",
  ],
  safetyNotes: [
    "Validates state transitions before updating durable state.",
  ],
} satisfies ToolCapabilityMetadata;
