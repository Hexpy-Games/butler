import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const reviewPlannedTaskToolDefinition = {
  type: "function",
  name: "review_planned_task",
  description: "Review a completed planned worker attempt against every acceptance criterion before any public completion report is generated.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      task_id: {
        type: "string",
        description: "Planned task id to review.",
      },
      attempt: {
        type: "integer",
        description: "Planned attempt number to review.",
      },
      worker_task_id: {
        type: "string",
        description: "Linked worker task id from the planned-review event.",
      },
      review_event_id: {
        type: "string",
        description: "Planned-review event id used to reject stale review turns.",
      },
      criteria: {
        type: "array",
        description: "Per-criterion review results with evidence.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            criterion_index: {
              type: "integer",
              description: "Preferred stable 1-based acceptance-criterion index, for example 1 for AC1.",
            },
            criterion: {
              type: "string",
            },
            verdict: {
              type: "string",
              enum: [
                "PASS",
                "FAIL",
                "INCONCLUSIVE",
              ],
            },
            evidence: {
              type: "string",
            },
          },
          required: [
            "verdict",
            "evidence",
          ],
        },
      },
      goal_review: {
        type: "object",
        description: "Internal GOAL completion review. PASS is required before a planned task can become reportable.",
        additionalProperties: false,
        properties: {
          verdict: {
            type: "string",
            enum: [
              "PASS",
              "FAIL",
              "INCONCLUSIVE",
            ],
          },
          evidence: {
            type: "string",
            description: "Evidence that the internal GOAL is complete, blocked, or still incomplete.",
          },
        },
        required: [
          "verdict",
          "evidence",
        ],
      },
      missing_evidence: {
        type: "array",
        description: "Evidence that is missing or insufficient.",
        items: {
          type: "string",
        },
      },
      repair_recommendation: {
        type: "string",
        description: "Recommended autonomous repair, or empty when no repair is needed.",
      },
    },
    required: [
      "task_id",
      "criteria",
    ],
  },
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const reviewPlannedTaskToolMetadata = {
  category: "dispatch",
  tags: [
    "planned",
    "review",
    "evidence",
    "criteria",
  ],
  safetyNotes: [
    "Every acceptance criterion needs evidence before completion can pass.",
  ],
} satisfies ToolCapabilityMetadata;
