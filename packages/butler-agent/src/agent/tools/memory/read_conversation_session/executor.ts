import {
  readConversationSession,
  type ConversationSessionReferenceScope,
} from "../../../context/conversation-session-reference.ts";
import type { ConversationContextDirection } from
  "../../../context/conversation-context.ts";
import type { createMemoryToolHandlers } from "../shared.ts";

export function createReadConversationSessionToolHandler(
  input: Parameters<typeof createMemoryToolHandlers>[0],
) {
  return async (call: { args: Record<string, unknown> }) => {
    const conversationSessionId = typeof call.args.conversation_session_id === "string"
      ? call.args.conversation_session_id.trim()
      : "";
    if (!conversationSessionId) {
      throw new Error("read_conversation_session requires conversation_session_id");
    }
    return readConversationSession({
      butlerData: input.butlerData,
      currentSessionId: input.sessionId ?? "butler/main",
      conversationSessionId,
      projectId: input.projectId,
      scope: sessionScope(call.args.scope),
      anchorMessageId: typeof call.args.anchor_message_id === "string"
        ? call.args.anchor_message_id
        : undefined,
      direction: direction(call.args.direction),
      limit: typeof call.args.limit === "number" ? call.args.limit : undefined,
      maxChars: typeof call.args.max_chars === "number" ? call.args.max_chars : undefined,
      includeTools: call.args.include_tools === true,
    });
  };
}

function sessionScope(value: unknown): ConversationSessionReferenceScope | undefined {
  return value === "current_project" || value === "all_sessions" ? value : undefined;
}

function direction(value: unknown): ConversationContextDirection | undefined {
  return value === "before" || value === "after" || value === "around"
    ? value
    : undefined;
}
