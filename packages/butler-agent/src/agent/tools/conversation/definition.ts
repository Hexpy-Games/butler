import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";

export const startTopicConversationDefinition = {
  type: "function", name: "start_topic_conversation",
  description: "Start a new topic conversation or project from an answer in an existing Butler conversation, only when the user asks to move or split the topic. Preserves the source and carries its summarized context. Does not start execution unless follow_up is explicitly provided from the user's instruction.",
  parameters: {
    type: "object", additionalProperties: false,
    properties: {
      title: { type: "string", description: "Short user-facing title in the user's language." },
      source_session_id: { type: "string", description: "Optional session id from conversation discovery (App, external, or canonical). Defaults to this conversation." },
      source_message_id: { type: "string", description: "Optional answer id (App or canonical). Defaults to the latest completed answer in the source." },
      destination: { type: "string", enum: ["chat", "project", "new_project"] },
      project_id: { type: "string", description: "Existing App project id, required for destination=project." },
      follow_up: { type: "string", description: "Only when the user explicitly asked to continue work there: the instruction to submit once in the new conversation. Omit to just create it." },
    }, required: ["title", "destination"],
  },
  effectBoundary: "reviewed_persistent", concurrencySafe: false,
  interruptBehavior: "continue", transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const startTopicConversationMetadata = {
  category: "control", tags: ["conversation", "topic", "project", "split", "대화", "주제", "분리", "옮기기"],
  safetyNotes: ["Only create or start a conversation at the user's explicit request. A reference grants no write permission to the source."],
} satisfies ToolCapabilityMetadata;
