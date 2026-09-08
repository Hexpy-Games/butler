import type {
  ButlerToolDefinition,
  ToolCapabilityMetadata,
} from "../../types.ts";

export const readConversationSessionToolDefinition = {
  type: "function",
  name: "read_conversation_session",
  toolContractVersion: 2,
  description:
    "Read canonical conversation context or an exact source_ref returned by recall_memory.",
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
        description: "Read scope. Must allow the selected canonical session.",
      },
      source_ref: { type: "string" },
      anchor_message_id: {
        type: "string",
        description:
          "Optional canonical conversation_message_id to read around.",
      },
      direction: {
        type: "string",
        enum: ["before", "after", "around"],
        description:
          "Slice direction relative to the anchor; without an anchor the latest messages are returned.",
      },
      limit: {
        type: "integer",
        description: "Maximum canonical messages to return.",
      },
      max_chars: {
        type: "integer",
        description: "Maximum character budget for returned conversation text.",
      },
      include_tools: {
        type: "boolean",
        description:
          "Include canonical tool call/result parts only when tool adjacency is material.",
      },
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
