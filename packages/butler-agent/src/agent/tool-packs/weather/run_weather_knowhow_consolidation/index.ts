import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../../tools/types.ts";

export const runWeatherKnowhowConsolidationToolDefinition = {
  type: "function",
  name: "run_weather_knowhow_consolidation",
  description: "Apply active weather feedback to Butler Cognition weather know-how state during a manual consolidation review.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {},
    required: [],
  },
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const runWeatherKnowhowConsolidationToolMetadata = {
  category: "memory",
  tags: [
    "weather",
    "consolidation",
    "feedback",
    "know-how",
    "정리",
    "노하우",
  ],
  safetyNotes: [
    "Applies active weather feedback to know-how state without exposing raw private text.",
  ],
} satisfies ToolCapabilityMetadata;
