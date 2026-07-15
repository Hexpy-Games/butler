import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const queryProjectWorkToolDefinition = {
  type: "function",
  name: "query_project_work",
  description: "Query active Project Ledger next actions, blockers, specs, risks, or stale views.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      project_ref: {
        type: "string",
        description: "Project id/name/workspace/canonical root; omit for active project.",
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
    "Use Ledger list/show/status before broad file reads.",
  ],
  satisfiesCompletionObligations: [
    "source_verified",
  ],
  btcc: {
    effects: ["observe"],
    purposes: ["execution", "review"],
    scopes: ["project"],
    ledgerOperation: "read",
  },
} satisfies ToolCapabilityMetadata;
