import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const completeProjectWorkToolDefinition = {
  type: "function",
  name: "complete_project_work",
  description: "Complete a Project Ledger work item through the same evidence gate used by the CLI.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      project_ref: {
        type: "string",
        description: "Project id/name/workspace/canonical root; omit for active project.",
      },
      id: {
        type: "string",
        description: "Work id to complete.",
      },
      validation: {
        type: "string",
        description: "Validation evidence summary or path.",
      },
      review: {
        type: "string",
        description: "Review evidence summary or path.",
      },
      report: {
        type: "string",
        description: "Completion report path.",
      },
    },
    required: [
      "id",
      "validation",
      "review",
      "report",
    ],
  },
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const completeProjectWorkToolMetadata = {
  category: "project",
  tags: [
    "project",
    "ledger",
    "complete",
    "evidence",
    "review",
    "report",
  ],
  safetyNotes: [
    "Requires validation, review, and report evidence before completing work.",
  ],
} satisfies ToolCapabilityMetadata;
