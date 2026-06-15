import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../../tools/types.ts";

export const getWeatherWithKnowhowToolDefinition = {
  type: "function",
  name: "get_weather_with_knowhow",
  description: "Get current weather from live timestamped weather sources using Butler Cognition know-how.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      latitude: {
        type: "number",
        description: "WGS84 latitude for the weather location.",
      },
      longitude: {
        type: "number",
        description: "WGS84 longitude for the weather location.",
      },
      location: {
        type: "string",
        description: "Human-readable location name.",
      },
    },
    required: [
      "latitude",
      "longitude",
    ],
  },
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const getWeatherWithKnowhowToolMetadata = {
  category: "search",
  tags: [
    "weather",
    "forecast",
    "current",
    "freshness",
    "know-how",
    "날씨",
    "기상",
    "노하우",
  ],
  safetyNotes: [
    "Fetches live weather source data and validates source timestamps before answering.",
  ],
} satisfies ToolCapabilityMetadata;
