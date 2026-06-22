import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const toolCallToolDefinition = {
  type: "function",
  name: "tool_call",
  description: "Invoke a described progressive tool by explicit catalog id through Butler's normal guarded dispatcher.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: {
        type: "string",
        description: "Exact tool catalog id returned by tool_search/tool_describe.",
      },
      arguments: {
        type: "object",
        description: "Arguments matching the described target tool schema.",
        additionalProperties: true,
      },
    },
    required: [
      "id",
      "arguments",
    ],
  },
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const toolCallToolMetadata = {
  category: "control",
  tags: [
    "tools",
    "bridge",
    "invoke",
    "dispatch",
  ],
  safetyNotes: [
    "Invokes only explicit catalog ids and routes execution through existing Butler tool guardrails.",
  ],
} satisfies ToolCapabilityMetadata;
