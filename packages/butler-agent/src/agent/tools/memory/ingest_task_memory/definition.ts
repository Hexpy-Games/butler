import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const ingestTaskMemoryToolDefinition = {
  type: "function",
  name: "ingest_task_memory",
  description: "Ingest a completed task outcome or reviewed public report into durable task memory with provenance.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      task_id: {
        type: "string",
        description: "Completed or failed task id to ingest.",
      },
    },
    required: [
      "task_id",
    ],
  },
  effectBoundary: "turn_local",
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const ingestTaskMemoryToolMetadata = {
  category: "memory",
  tags: [
    "memory",
    "ingest",
    "task",
  ],
  safetyNotes: [
    "Ingest only completed task outcomes with durable evidence.",
  ],
} satisfies ToolCapabilityMetadata;
