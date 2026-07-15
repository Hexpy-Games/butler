import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const getContextMonitorToolDefinition = {
  type: "function",
  name: "get_context_monitor",
  description: "Inspect safe context pressure telemetry for the active session: prompt sizes, recall size, transcript growth, and estimated token pressure without raw prompt text.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      session_id: {
        type: "string",
        description: "Optional session id. Defaults to the active Butler session when available.",
      },
    },
    required: [],
  },
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const getContextMonitorToolMetadata = {
  category: "monitoring",
  tags: [
    "context",
    "tokens",
    "pressure",
    "prompt",
  ],
  safetyNotes: [
    "Reports sizes and counters only, not raw private text.",
  ],
  satisfiesCompletionObligations: [
    "source_verified",
  ],
  btcc: {
    effects: ["observe"],
    purposes: ["intent_grounding", "planning", "execution", "review"],
    scopes: ["turn"],
  },
} satisfies ToolCapabilityMetadata;
