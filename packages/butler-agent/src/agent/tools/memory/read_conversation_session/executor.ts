import {
  readConversationSession,
  type ConversationSessionReferenceScope,
} from "../../../context/conversation-session-reference.ts";
import type { ConversationContextDirection } from "../../../context/conversation-context.ts";
import type { createMemoryToolHandlers } from "../shared.ts";
import type { ButlerToolCall } from "../../types.ts";

export function createReadConversationSessionToolHandler(
  input: Parameters<typeof createMemoryToolHandlers>[0],
) {
  return async (call: ButlerToolCall) => {
    const version = call.toolContractVersion ?? 1;
    if (version === 2 && (!input.sessionId?.trim() || !input.turnId?.trim())) {
      throw new Error(
        "read_conversation_session v2 requires runtime session and turn binding",
      );
    }
    const sourceRef =
      typeof call.args.source_ref === "string"
        ? call.args.source_ref.trim()
        : "";
    const conversationSessionId =
      typeof call.args.conversation_session_id === "string"
        ? call.args.conversation_session_id.trim()
        : "";
    if (
      version === 2 &&
      Boolean(conversationSessionId) === Boolean(sourceRef)
    ) {
      throw new Error(
        "read_conversation_session requires exactly one of conversation_session_id or source_ref",
      );
    }
    if (version === 1 && !conversationSessionId) {
      throw new Error(
        "read_conversation_session requires conversation_session_id",
      );
    }
    const common = {
      butlerData: input.butlerData,
      currentSessionId: input.sessionId ?? "butler/main",
      conversationSessionId,
      projectId: input.projectId,
      scope: sessionScope(call.args.scope),
      anchorMessageId:
        typeof call.args.anchor_message_id === "string"
          ? call.args.anchor_message_id
          : undefined,
      direction: direction(call.args.direction),
      limit: typeof call.args.limit === "number" ? call.args.limit : undefined,
      maxChars:
        typeof call.args.max_chars === "number"
          ? call.args.max_chars
          : undefined,
      includeTools: call.args.include_tools === true,
    };
    return version === 2 && sourceRef
      ? readConversationSession({ ...common, sourceRef })
      : readConversationSession({ ...common, sourceRef: undefined });
  };
}

function sessionScope(
  value: unknown,
): ConversationSessionReferenceScope | undefined {
  return value === "current_session" ||
    value === "current_project" ||
    value === "all_user_sessions" ||
    value === "all_sessions"
    ? value
    : undefined;
}

function direction(value: unknown): ConversationContextDirection | undefined {
  return value === "before" || value === "after" || value === "around"
    ? value
    : undefined;
}
