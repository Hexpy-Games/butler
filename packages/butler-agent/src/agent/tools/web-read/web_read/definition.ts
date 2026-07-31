import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const webReadToolDefinition = {
  type: "function",
  name: "web_read",
  description: "Read a public URL through Butler's configured page-reader stack and return bounded page evidence. Use after web_search when snippets are insufficient for exact quotes, current news, or source-backed claims.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      url: {
        type: "string",
        description: "Public http(s) URL to read.",
      },
      max_chars: {
        type: "integer",
        description: "Maximum markdown characters returned to the model.",
      },
      max_chunks: {
        type: "integer",
        description: "Maximum evidence chunks returned.",
      },
      backend: {
        type: "string",
        enum: [
          "auto",
          "lightpanda",
          "lightweight",
          "jina-hosted",
          "disabled",
        ],
        description: "Optional page reader backend override.",
      },
    },
    required: [
      "url",
    ],
  },
  effectBoundary: "none",
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const webReadToolMetadata = {
  category: "search",
  tags: [
    "web",
    "read",
    "page",
    "source",
    "evidence",
    "원문",
    "근거",
    "출처",
  ],
  safetyNotes: [
    "Read bounded public page evidence; do not dump full pages into final answers.",
  ],
} satisfies ToolCapabilityMetadata;
