import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";

export const queryMemoryToolDefinition = {
  type: "function",
  name: "query_memory",
  description: "Query durable Butler conversation transcripts for exact memory/history evidence such as dates, counts, first/last, earliest/latest, speaker-specific, or text-filtered transcript facts. Use when exact transcript evidence is needed. Returns conversational inbound/outbound text only, never tool payloads.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "Optional exact text or terms to match in conversational transcript text. Omit to inspect all matching conversation events.",
      },
      scope: {
        type: "string",
        enum: [
          "all_sessions",
          "session",
        ],
        description: "Search all durable Butler sessions, or only the active/requested session.",
      },
      session_id: {
        type: "string",
        description: "Session id to search when scope is session. Defaults to the current session when available.",
      },
      speaker: {
        type: "string",
        enum: [
          "any",
          "user",
          "butler",
        ],
        description: "Filter to user inbound messages, Butler outbound messages, or both.",
      },
      event_kind: {
        type: "string",
        enum: [
          "any",
          "inbound",
          "outbound",
        ],
        description: "Filter by transcript event kind.",
      },
      order: {
        type: "string",
        enum: [
          "earliest",
          "latest",
        ],
        description: "Return chronological earliest or latest matching conversation events first.",
      },
      match_mode: {
        type: "string",
        enum: [
          "any",
          "all",
          "phrase",
        ],
        description: "How query terms should match transcript text.",
      },
      limit: {
        type: "integer",
        description: "Maximum number of exact transcript matches to return.",
      },
      date_from: {
        type: "string",
        description: "Optional inclusive lower timestamp/date bound parseable by Date.parse.",
      },
      date_to: {
        type: "string",
        description: "Optional inclusive upper timestamp/date bound parseable by Date.parse.",
      },
      include_internal: {
        type: "boolean",
        description: "Include internal steward/session events. Defaults to false for user-facing memory queries.",
      },
      include_placeholders: {
        type: "boolean",
        description: "Include mock or epoch placeholder transcript events. Defaults to false.",
      },
    },
    required: [],
  },
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const queryMemoryToolMetadata = {
  category: "memory",
  tags: [
    "memory",
    "query",
    "transcript",
    "exact",
    "date",
    "earliest",
    "latest",
  ],
  safetyNotes: [
    "Use for exact transcript/history dates, counts, earliest/latest evidence, not associative recall.",
  ],
  satisfiesCompletionObligations: [
    "source_verified",
  ],
} satisfies ToolCapabilityMetadata;
