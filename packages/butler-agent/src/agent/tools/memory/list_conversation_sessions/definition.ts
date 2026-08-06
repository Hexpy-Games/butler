import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const listConversationSessionsToolDefinition = {
  type: "function",
  name: "list_conversation_sessions",
  description: "Discover bounded canonical Butler conversation sessions before referencing another chat. Defaults to the active project when present; use all_sessions when the user explicitly refers to a session in another project. App titles are labeled compatibility metadata, while previews come from canonical conversation messages.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      scope: {
        type: "string",
        enum: ["current_project", "all_sessions"],
        description: "Session discovery scope. Defaults to current_project when a project is active, otherwise all_sessions.",
      },
      limit: {
        type: "integer",
        description: "Maximum sessions to return, from 1 to 100.",
      },
      include_archived: {
        type: "boolean",
        description: "Include archived canonical sessions.",
      },
      preview_messages: {
        type: "integer",
        description: "Recent canonical user/assistant messages per session, from 1 to 6.",
      },
    },
    required: [],
  },
  effectBoundary: "none",
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const listConversationSessionsToolMetadata = {
  category: "memory",
  tags: ["conversation", "session", "discover", "history", "대화", "세션", "이전"],
  safetyNotes: [
    "Returns bounded local canonical session metadata and previews; App titles are compatibility labels only.",
  ],
  satisfiesCompletionObligations: ["source_verified"],
} satisfies ToolCapabilityMetadata;
