import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";

export const runReadyWorkStreamsToolDefinition = {
  type: "function",
  name: "run_ready_work_streams",
  description: "Dispatch dependency-ready pending streams for a work orchestration and record worker task ids before returning.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      orchestration_id: {
        type: "string",
      },
      max_streams: {
        type: "number",
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

export const runReadyWorkStreamsToolMetadata = {
  category: "dispatch",
  tags: [
    "orchestration",
    "dispatch",
    "dependencies",
    "streams",
    "워커",
    "의존성",
  ],
  safetyNotes: [
    "Dispatches only dependency-ready pending streams and records worker ids before returning.",
  ],
} satisfies ToolCapabilityMetadata;
