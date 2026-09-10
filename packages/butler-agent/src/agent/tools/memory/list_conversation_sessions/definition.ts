import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const listConversationSessionsToolDefinition = {
  type: "function",
  name: "list_conversation_sessions",
  toolContractVersion: 2,
  description: "Discover canonical conversation sessions after applying scope, project, origin, and conversation-time filters. App titles are compatibility labels only.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      scope: {
        type: "string",
        enum: ["current_session", "current_project", "all_user_sessions"],
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
      session_ids: { type: "array", items: { type: "string" } },
      project_filter: { type: "string", enum: ["any", "unassigned", "selected"] },
      project_ids: { type: "array", items: { type: "string" } },
      include_internal: { type: "boolean" },
      session_kind: { type: "string", enum: ["any", "chat", "project", "unknown"] },
      time: {
        type: "object", additionalProperties: false,
        properties: { from: { type: "string" }, to: { type: "string" }, basis: { type: "string", enum: ["conversation"] } },
        required: ["from", "to", "basis"],
      },
      cursor: { type: "string" },
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
