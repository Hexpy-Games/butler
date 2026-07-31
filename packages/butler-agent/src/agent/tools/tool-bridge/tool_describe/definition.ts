import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const toolDescribeToolDefinition = {
  type: "function",
  name: "tool_describe",
  description: "Load full invocation schemas for explicit tool catalog ids returned by tool_search. Returns schemas only for requested ids.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      ids: {
        type: "array",
        description: "Tool catalog ids to describe.",
        items: { type: "string" },
      },
    },
    required: ["ids"],
  },
  effectBoundary: "none",
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const toolDescribeToolMetadata = {
  category: "control",
  tags: [
    "tools",
    "catalog",
    "describe",
    "schema",
    "bridge",
  ],
  safetyNotes: [
    "Discovery only; loads schemas for explicit catalog ids without executing tools.",
  ],
} satisfies ToolCapabilityMetadata;
