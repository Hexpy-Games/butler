import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";

export const getMemoryHealthToolDefinition = {
  type: "function",
  name: "get_memory_health",
  description: "Read Butler memory freshness, ingestion backlog, transcript count, task-memory count, and diagnostics.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {},
    required: [],
  },
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const getMemoryHealthToolMetadata = {
  category: "memory",
  tags: [
    "memory",
    "health",
    "graph",
    "vector",
  ],
  safetyNotes: [
    "Reports counts and freshness only, not private memory text.",
  ],
  satisfiesCompletionObligations: [
    "source_verified",
  ],
} satisfies ToolCapabilityMetadata;
