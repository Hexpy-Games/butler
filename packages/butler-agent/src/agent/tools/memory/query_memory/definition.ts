import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const queryMemoryToolDefinition = {
  type: "function",
  name: "query_memory",
  description: "Query durable Butler conversation history for exact memory/history evidence such as dates, counts, first/last, earliest/latest, speaker-specific, or text-filtered conversation facts. Uses canonical conversation messages by default. Returns conversational inbound/outbound text only, never tool payloads.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "Optional exact text or terms to match in canonical conversation text. Omit to inspect all matching conversation events.",
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
        description: "How query terms should match conversation text.",
      },
      limit: {
        type: "integer",
        description: "Maximum number of exact conversation matches to return.",
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
        description: "Include internal recovered events when transcript recovery is explicitly requested. Defaults to false.",
      },
      include_placeholders: {
        type: "boolean",
        description: "Include mock or epoch placeholder recovery events when transcript recovery is explicitly requested. Defaults to false.",
      },
      include_transcript_recovery: {
        type: "boolean",
        description: "Explicitly include the migration-only transcript recovery index after canonical and app compatibility sources.",
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
    "conversation",
    "exact",
    "date",
    "earliest",
    "latest",
  ],
  safetyNotes: [
    "Use for exact conversation/history dates, counts, earliest/latest evidence, not associative recall.",
  ],
  satisfiesCompletionObligations: [
    "source_verified",
  ],
} satisfies ToolCapabilityMetadata;
