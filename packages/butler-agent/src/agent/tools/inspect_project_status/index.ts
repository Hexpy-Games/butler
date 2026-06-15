import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";

export const inspectProjectStatusToolDefinition = {
  type: "function",
  name: "inspect_project_status",
  description: "Inspect the canonical Butler data-home Project Ledger status summary without reading broad project files.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      project_path: {
        type: "string",
        description: "Absolute workspace/project path used to resolve the canonical Project Ledger under BUTLER_DATA/project-ledger/projects. Defaults to the Butler repository.",
      },
    },
    required: [],
  },
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
    "Returns bounded Project Ledger status; read referenced files only when needed.",
  ],
  satisfiesCompletionObligations: [
    "source_verified",
  ],
} satisfies ToolCapabilityMetadata;
