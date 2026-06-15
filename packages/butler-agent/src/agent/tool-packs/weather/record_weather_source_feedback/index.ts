import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../../tools/types.ts";

export const recordWeatherSourceFeedbackToolDefinition = {
  type: "function",
  name: "record_weather_source_feedback",
  description: "Record explicit user feedback that a weather source or weather know-how result was inaccurate, unwanted, or should be avoided next time. If source is omitted, Butler attaches the feedback to the latest weather source used in this session when available.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      source: {
        type: "string",
        enum: [
          "open-meteo",
          "nws",
        ],
        description: "Weather source receiving the feedback.",
      },
      text: {
        type: "string",
        description: "User feedback text.",
      },
    },
    required: [
      "text",
    ],
  },
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const recordWeatherSourceFeedbackToolMetadata = {
  category: "memory",
  tags: [
    "weather",
    "feedback",
    "source-quality",
    "know-how",
    "피드백",
    "날씨",
  ],
  safetyNotes: [
    "Records explicit user feedback for immediate source suppression and later consolidation.",
  ],
} satisfies ToolCapabilityMetadata;
