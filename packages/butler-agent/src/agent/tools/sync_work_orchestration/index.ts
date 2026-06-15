import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";

export const syncWorkOrchestrationToolDefinition = {
  type: "function",
  name: "sync_work_orchestration",
  description: "Sync a work orchestration from durable worker task state, promoting linked streams to done or failed from evidence.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      orchestration_id: {
        type: "string",
      },
    },
    required: [
      "orchestration_id",
    ],
  },
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const syncWorkOrchestrationToolMetadata = {
  category: "dispatch",
  tags: [
    "orchestration",
    "sync",
    "results",
    "workers",
    "결과",
  ],
  safetyNotes: [
    "Promotes streams only from durable worker task state.",
  ],
} satisfies ToolCapabilityMetadata;
