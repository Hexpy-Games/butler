import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const writeWorkOrchestrationReportToolDefinition = {
  type: "function",
  name: "write_work_orchestration_report",
  description: "Write a public orchestration report after every work stream is terminal. Completion can be claimed only when every non-skipped stream is done.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      orchestration_id: {
        type: "string",
      },
      report: {
        type: "string",
      },
    },
    required: [
      "orchestration_id",
      "report",
    ],
  },
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const writeWorkOrchestrationReportToolMetadata = {
  category: "dispatch",
  tags: [
    "orchestration",
    "report",
    "synthesis",
    "review",
    "보고",
  ],
  safetyNotes: [
    "Only reports after all streams are terminal; partial outcomes must not claim completion.",
  ],
} satisfies ToolCapabilityMetadata;
