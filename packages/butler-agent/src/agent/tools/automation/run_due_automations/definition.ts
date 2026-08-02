import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const runDueAutomationsToolDefinition = {
  type: "function",
  name: "run_due_automations",
  description: "Claim due native Butler automations and return transport-neutral inbound events for gateway processing.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      now: {
        type: "string",
        description: "Optional ISO timestamp for deterministic runs.",
      },
    },
    required: [],
  },
  effectBoundary: "reviewed_persistent",
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const runDueAutomationsToolMetadata = {
  category: "automation",
  tags: [
    "schedule",
    "automation",
    "due",
  ],
  safetyNotes: [
    "Claims due work; do not run repeatedly unless scheduling state requires it.",
  ],
} satisfies ToolCapabilityMetadata;
