import type {
  ButlerToolDefinition,
  ToolCapabilityMetadata,
} from "../../types.ts";

export const recallMemoryToolDefinition = {
  type: "function",
  name: "recall_memory",
  toolContractVersion: 2,
  description:
    "Recall source-backed associative context through graph evidence. Use evidence.read_args unchanged with read_conversation_session to inspect canonical source text.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      cue: {
        type: "string",
        description: "Memory recall cue text.",
      },
      limit: {
        type: "integer",
        description: "Maximum number of memory recall results.",
      },
      include_vector: {
        type: "boolean",
        description:
          "Whether to try vector episode search in addition to lexical, graph, project/task, and explicit memory. Defaults to true for tool calls.",
      },
      seed_phrases: {
        type: "array",
        items: { type: "string" },
      },
      vector_queries: {
        type: "array",
        items: { type: "string" },
      },
      scope: {
        type: "string",
        enum: ["current_session", "current_project", "all_user_sessions"],
      },
      include_internal: { type: "boolean" },
      cursor: { type: "string" },
      as_of: { type: "string" },
      session_ids: { type: "array", items: { type: "string" } },
      project_filter: {
        type: "string",
        enum: ["any", "unassigned", "selected"],
      },
      project_ids: { type: "array", items: { type: "string" } },
      time: {
        type: "object",
        additionalProperties: false,
        description: "Half-open ISO 8601 interval [from, to) with explicit UTC offsets.",
        properties: {
          from: { type: "string", description: "Inclusive start, as an ISO 8601 timestamp with an explicit UTC offset." },
          to: { type: "string", description: "Exclusive end, as an ISO 8601 timestamp with an explicit UTC offset. For a complete calendar period, use the start of the next period in the user's timezone; do not subtract a smaller time unit." },
          basis: { type: "string", enum: ["conversation", "event"] },
        },
        required: ["from", "to", "basis"],
      },
    },
    required: ["cue"],
  },
  effectBoundary: "none",
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const recallMemoryToolMetadata = {
  category: "memory",
  tags: ["memory", "recall", "association", "search"],
  safetyNotes: ["Treat recall as evidence to consider, not guaranteed truth."],
  satisfiesCompletionObligations: ["source_verified"],
} satisfies ToolCapabilityMetadata;
