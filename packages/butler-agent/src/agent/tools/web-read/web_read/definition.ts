import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const webReadToolDefinition = {
  type: "function",
  name: "web_read",
  description: "Read a public URL through Butler's configured page-reader stack and return bounded page evidence. Use after web_search when snippets are insufficient for exact quotes, current news, or source-backed claims. When content_has_more is true, continue with start_chunk set to next_start_chunk; returned_chunks counts only complete chunks included in the current result. If a page is unavailable, search for an accessible source covering the same requested fact.",
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
        minimum: 1_500,
        maximum: 8_000,
        default: 2_000,
        description: "Maximum markdown characters returned for the selected chunk window (1500-8000, default 2000). The minimum fits one built-in evidence chunk. Use start_chunk, not a larger max_chars, to continue reading later chunks.",
      },
      max_chunks: {
        type: "integer",
        minimum: 1,
        maximum: 8,
        default: 1,
        description: "Maximum evidence chunks returned from start_chunk (1-8, default 1).",
      },
      start_chunk: {
        type: "integer",
        minimum: 0,
        default: 0,
        description: "Zero-based chunk offset for continuing through the page (default 0). Use next_start_chunk from the previous result.",
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
