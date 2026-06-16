import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const renderProjectDashboardToolDefinition = {
  type: "function",
  name: "render_project_dashboard",
  description: "Render Project Ledger dashboard, handoff, or roadmap views from canonical Butler data-home Project Ledger state.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      project_path: {
        type: "string",
        description: "Absolute workspace/project path used to resolve the canonical Project Ledger under BUTLER_DATA/project-ledger/projects. Defaults to the Butler repository.",
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
