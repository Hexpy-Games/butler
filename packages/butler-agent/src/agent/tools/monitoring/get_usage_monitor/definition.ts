import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const getUsageMonitorToolDefinition = {
  type: "function",
  name: "get_usage_monitor",
  description: "Inspect safe model/cache, web-search, and tool usage counters without raw prompts, messages, tool arguments, or tool results.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      session_id: {
        type: "string",
        description: "Optional session id for transcript-derived tool usage.",
      },
      since_hours: {
        type: "number",
        description: "Optional lookback window in hours for timestamped metrics.",
      },
    },
    required: [],
  },
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const getUsageMonitorToolMetadata = {
  category: "monitoring",
  tags: [
    "usage",
    "cost",
    "cache",
    "tokens",
    "tools",
  ],
  safetyNotes: [
    "Report cost as unavailable unless the tool provides an authoritative estimate.",
  ],
  satisfiesCompletionObligations: [
    "source_verified",
  ],
} satisfies ToolCapabilityMetadata;
