import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const inspectProjectStatusToolDefinition = {
  type: "function",
  name: "inspect_project_status",
  description: "Inspect active Project Ledger status without broad file reads.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      project_ref: {
        type: "string",
        description: "Project id/name/workspace/canonical root; omit for active project.",
      },
    },
    required: [],
  },
  effectBoundary: "none",
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const inspectProjectStatusToolMetadata = {
  category: "project",
  tags: [
    "project",
    "ledger",
    "status",
    "progress",
    "roadmap",
    "handoff",
  ],
  safetyNotes: [
    "Use Ledger list/show/query before broad file reads.",
  ],
  satisfiesCompletionObligations: [
    "source_verified",
  ],
} satisfies ToolCapabilityMetadata;
