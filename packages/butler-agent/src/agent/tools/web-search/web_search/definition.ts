import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const webSearchToolDefinition = {
  type: "function",
  name: "web_search",
  description: "Search the public web for current or external information. Use this for recent information, public sources, and research that needs citations; Butler may plan multiple focused searches internally when smart search planning is enabled. For broad research, discover sources without a domain filter first; if a filtered or source-specific search is empty or blocked, broaden the query or use another accessible authoritative or reputable source.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "Search request or missing evidence. For broad research, let Butler plan diverse sources instead of narrowing every search to a few sites.",
      },
      allowed_domains: {
        type: "array",
        description: "Strict result filter for every planned search. Omit it for broad or multi-source research because it can exclude useful alternative evidence. Use it when the user requires specific domains or for a deliberately narrow follow-up on known sources.",
        items: {
          type: "string",
        },
      },
      blocked_domains: {
        type: "array",
        description: "Exclude results from these domains while leaving other sources available.",
        items: {
          type: "string",
        },
      },
      recency_days: {
        type: "integer",
        description: "Optional freshness hint in days.",
      },
      max_results: {
        type: "integer",
        description: "Maximum number of results to return.",
      },
    },
    required: [
      "query",
    ],
  },
  effectBoundary: "none",
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const webSearchToolMetadata = {
  category: "search",
  tags: [
    "web",
    "search",
    "current",
    "sources",
    "citations",
    "검색",
    "최신",
    "출처",
  ],
  safetyNotes: [
    "Use citations from returned source URLs; do not invent sources.",
  ],
} satisfies ToolCapabilityMetadata;
