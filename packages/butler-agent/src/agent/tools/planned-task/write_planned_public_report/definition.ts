import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const writePlannedPublicReportToolDefinition = {
  type: "function",
  name: "write_planned_public_report",
  description: "Write the final user-facing report for a reviewed planned task. Use only after review passes or a failure/partial report is ready. The report must answer the user's requested deliverable, not summarize Butler's internal review.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      task_id: {
        type: "string",
        description: "Planned task id to report.",
      },
      report: {
        type: "string",
        description: "Complete user-facing final answer, shaped by the planned task public_report_policy. Do not include review verdicts, PASS/FAIL criterion evidence, internal ids, raw worker prompts, or full worker/review artifacts unless explicitly requested by the user.",
      },
      outcome: {
        type: "string",
        description: "Legacy concise final outcome; prefer report.",
      },
      what_was_done: {
        type: "array",
        items: {
          type: "string",
        },
        description: "Legacy fallback bullets; prefer report.",
      },
      residual_risk: {
        type: "array",
        items: {
          type: "string",
        },
        description: "Legacy fallback risks; prefer report.",
      },
      next_action: {
        type: "string",
        description: "Legacy fallback next action; prefer report.",
      },
    },
    required: [
      "task_id",
      "report",
    ],
  },
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const writePlannedPublicReportToolMetadata = {
  category: "dispatch",
  tags: [
    "planned",
    "report",
    "public",
    "review",
  ],
  safetyNotes: [
    "Only after review/reporting guards allow public reporting; report content must be user-facing.",
  ],
} satisfies ToolCapabilityMetadata;
