import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const getWorkDashboardToolDefinition = {
  type: "function",
  name: "get_work_dashboard",
  description: "Read Butler's canonical work dashboard: active work, recoverable work, failures, report-ready items, and delivery backlog.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      debug: {
        type: "boolean",
        description: "When true, include raw task and delivery identifiers for operator troubleshooting.",
      },
      limit: {
        type: "integer",
        description: "Maximum items per dashboard section.",
      },
    },
    required: [],
  },
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const getWorkDashboardToolMetadata = {
  category: "work",
  tags: [
    "status",
    "dashboard",
    "work",
    "tasks",
    "상태",
    "작업",
  ],
  safetyNotes: [
    "Use mode/safety fields before claiming completion.",
  ],
  satisfiesCompletionObligations: [
    "source_verified",
  ],
} satisfies ToolCapabilityMetadata;
