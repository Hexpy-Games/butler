import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const toolSearchToolDefinition = {
  type: "function",
  name: "tool_search",
  description: "Search Butler's compact deferred tool catalog by model-selected capability, category, provider, or query. Returns metadata and schema digests only.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "Optional free-form model query for loaded tool names, summaries, and tags.",
      },
      capability: {
        type: "string",
        description: "Optional capability term such as search, files, memory, command, or citations.",
      },
      category: {
        type: "string",
        description: "Optional exact capability category filter.",
      },
      provider: {
        type: "string",
        description: "Optional exact provider filter: native, mcp, or plugin. Set provider=mcp to include live MCP tools.",
      },
      include_disabled: {
        type: "boolean",
        description: "Whether to include disabled tools. Defaults to true.",
      },
      limit: {
        type: "integer",
        description: "Maximum compact results to return, 1 through 50. Defaults to 20.",
      },
    },
    required: [],
  },
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const toolSearchToolMetadata = {
  category: "control",
  tags: [
    "tools",
    "catalog",
    "search",
    "deferred",
    "bridge",
  ],
  safetyNotes: [
    "Discovery only; returns compact metadata and schema digests without executing tools.",
  ],
} satisfies ToolCapabilityMetadata;
