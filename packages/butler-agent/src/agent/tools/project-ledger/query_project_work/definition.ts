import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const queryProjectWorkToolDefinition = {
  type: "function",
  name: "query_project_work",
  description: "Query the canonical Butler data-home Project Ledger for bounded project-management references such as next actions, blockers, missing specs, risks, and stale views.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      project_path: {
        type: "string",
        description: "Absolute workspace/project path used to resolve the canonical Project Ledger under BUTLER_DATA/project-ledger/projects. Defaults to the Butler repository.",
      },
      kind: {
        type: "string",
        enum: [
          "next-actions",
          "blocked",
          "review",
          "missing-spec",
          "stale-view",
          "recent-completed",
          "completion-gaps",
          "stale-index",
          "decision-without-implementation",
          "risk-without-mitigation",
        ],
        description: "Project Ledger query family.",
      },
    },
    required: [
      "kind",
    ],
  },
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const queryProjectWorkToolMetadata = {
  category: "project",
  tags: [
    "project",
    "ledger",
    "query",
    "next",
    "blocked",
    "review",
    "risk",
  ],
  safetyNotes: [
    "Use bounded query results before broad project-file reads.",
  ],
  satisfiesCompletionObligations: [
    "source_verified",
  ],
} satisfies ToolCapabilityMetadata;
