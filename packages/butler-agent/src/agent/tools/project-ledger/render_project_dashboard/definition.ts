import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const renderProjectDashboardToolDefinition = {
  type: "function",
  name: "render_project_dashboard",
  description: "Render active Project Ledger dashboard, handoff, or roadmap views.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      project_ref: {
        type: "string",
        description: "Project id/name/workspace/canonical root; omit for active project.",
      },
      view: {
        type: "string",
        enum: [
          "dashboard",
          "handoff",
          "roadmap",
        ],
        description: "Generated view to render.",
      },
      write: {
        type: "boolean",
        description: "When true, write the generated view under the active Project Ledger views directory.",
      },
    },
    required: [
      "view",
    ],
  },
  effectBoundary: "reviewed_persistent",
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const renderProjectDashboardToolMetadata = {
  category: "project",
  tags: [
    "project",
    "ledger",
    "dashboard",
    "handoff",
    "roadmap",
    "render",
  ],
  safetyNotes: [
    "Generated views are derived output, not source of truth.",
  ],
} satisfies ToolCapabilityMetadata;
