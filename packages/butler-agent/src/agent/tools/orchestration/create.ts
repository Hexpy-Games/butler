import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";

export const createWorkOrchestrationToolDefinition = {
  type: "function",
  name: "create_work_orchestration",
  description: "Create a durable role-aware orchestration with dependency-aware work streams for complex multi-worker tasks.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: {
        type: "string",
        description: "Optional safe orchestration id.",
      },
      title: {
        type: "string",
        description: "Short user-facing title.",
      },
      goal: {
        type: "string",
        description: "Overall orchestration goal.",
      },
      streams: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
            },
            role: {
              type: "string",
            },
            objective: {
              type: "string",
            },
            acceptance_criteria: {
              type: "array",
              items: {
                type: "string",
              },
            },
            depends_on: {
              type: "array",
              items: {
                type: "string",
              },
            },
          },
          required: [
            "role",
            "objective",
            "acceptance_criteria",
          ],
        },
      },
    },
    required: [
      "goal",
      "streams",
    ],
  },
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const createWorkOrchestrationToolMetadata = {
  category: "dispatch",
  tags: [
    "orchestration",
    "multi-agent",
    "streams",
    "roles",
    "계획",
    "역할",
    "병렬",
  ],
  safetyNotes: [
    "Creates role-aware streams only; run_ready_work_streams is needed to dispatch work.",
  ],
} satisfies ToolCapabilityMetadata;
