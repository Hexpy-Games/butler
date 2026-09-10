import type {
  ButlerToolDefinition,
  ToolCapabilityMetadata,
} from "../../types.ts";

export const readConversationSessionToolDefinition = {
  type: "function",
  name: "read_conversation_session",
  toolContractVersion: 2,
  description:
    "Read exactly one canonical conversation session or one exact source_ref returned in recall_memory/query_memory read_args. Source mode accepts read_args unchanged and omits anchor_message_id, direction, include_tools, and limit; omit cursor on the first page and use returned cursors only with the same source.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      conversation_session_id: {
        type: "string",
        description:
          "Canonical conversation_session_id returned by list_conversation_sessions.",
      },
      scope: {
        type: "string",
        enum: ["current_session", "current_project", "all_user_sessions"],
        description: "Read scope. Explicit session/project filters only narrow it and never grant additional access.",
      },
      session_ids: { type: "array", items: { type: "string" } },
      project_filter: { type: "string", enum: ["any", "unassigned", "selected"], description: "Use selected only with non-empty project_ids; omit project_ids for any or unassigned." },
      project_ids: { type: "array", items: { type: "string" }, description: "Canonical project IDs that narrow selected project scope; they do not grant access." },
      include_internal: { type: "boolean" },
      source_ref: { type: "string", description: "Exact source locator from recall/query read_args. Use instead of conversation_session_id." },
      anchor_message_id: {
        type: "string",
        description:
          "Optional canonical conversation_message_id to read around.",
      },
      direction: {
        type: "string",
        enum: ["before", "after", "around"],
        description:
          "Session-mode slice direction relative to the anchor. Defaults to before. Omit in source mode.",
      },
      limit: {
        type: "integer",
        description: "Session-mode maximum canonical messages, 1 through 100. Defaults to 20. Omit in source mode.",
      },
      max_chars: {
        type: "integer",
        description: "Maximum character budget. Defaults to 8,000 in session mode and 4,000 in source mode.",
      },
      include_tools: {
        type: "boolean",
        description:
          "Session mode only. Include canonical tool call/result parts when material; defaults to false. Omit in source mode.",
      },
      cursor: { type: "string", description: "Source mode only. Omit initially and pass the returned cursor unchanged for the next page." },
    },
    required: [],
  },
  effectBoundary: "none",
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const readConversationSessionToolMetadata = {
  category: "memory",
  tags: [
    "conversation",
    "session",
    "read",
    "reference",
    "대화",
    "세션",
    "참조",
  ],
  safetyNotes: [
    "Reads bounded canonical messages only and revalidates the requested project/all-session scope.",
  ],
  satisfiesCompletionObligations: ["source_verified"],
} satisfies ToolCapabilityMetadata;
