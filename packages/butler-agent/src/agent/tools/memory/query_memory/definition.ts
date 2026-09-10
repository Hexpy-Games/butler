import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const queryMemoryToolDefinition = {
  type: "function",
  name: "query_memory",
  toolContractVersion: 2,
  description: "Search canonical conversation scalars exactly. Phrase mode uses the literal query; any/all modes require terms and omit query. Omitting both inspects all messages allowed by the scope, time, and role filters. Use returned read_args unchanged with read_conversation_session for the complete source scalar.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "Literal text for phrase mode. Omit in any/all mode. Omit both query and terms to inspect all messages allowed by the other filters.",
      },
      scope: {
        type: "string",
        enum: ["current_session", "current_project", "all_user_sessions"],
        description: "Canonical read scope. Explicit session/project filters only narrow this scope and never grant additional access.",
      },
      session_ids: { type: "array", items: { type: "string" } },
      project_filter: { type: "string", enum: ["any", "unassigned", "selected"], description: "Use selected only with non-empty project_ids; omit project_ids for any or unassigned." },
      project_ids: { type: "array", items: { type: "string" }, description: "Canonical project IDs that narrow selected project scope; they do not grant access." },
      speaker: {
        type: "string",
        enum: [
          "any",
          "user",
          "butler",
        ],
        description: "Filter to user inbound messages, Butler outbound messages, or both. Defaults to any.",
      },
      event_kind: {
        type: "string",
        enum: [
          "any",
          "inbound",
          "outbound",
        ],
        description: "Filter by transcript event kind. Defaults to any.",
      },
      order: {
        type: "string",
        enum: [
          "earliest",
          "latest",
        ],
        description: "Return chronological earliest or latest matching conversation events first. Defaults to earliest.",
      },
      match_mode: {
        type: "string",
        enum: [
          "any",
          "all",
          "phrase",
        ],
        description: "Defaults to phrase. Phrase uses query literally; any/all use the supplied terms without tokenizing query.",
      },
      terms: { type: "array", items: { type: "string" }, description: "Required non-empty literal terms for any/all mode. Omit in phrase mode." },
      case_sensitive: { type: "boolean", description: "Defaults to true. False applies Unicode default case folding without changing returned text." },
      limit: {
        type: "integer",
        description: "Maximum number of exact conversation matches to return, 1 through 50. Defaults to 10.",
      },
      time: {
        type: "object", additionalProperties: false,
        properties: { from: { type: "string" }, to: { type: "string" }, basis: { type: "string", enum: ["conversation"] } },
        required: ["from", "to", "basis"],
      },
      cursor: { type: "string" },
      include_internal: {
        type: "boolean",
        description: "Include internal recovered events when transcript recovery is explicitly requested. Defaults to false.",
      },
    },
    required: [],
  },
  effectBoundary: "none",
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
