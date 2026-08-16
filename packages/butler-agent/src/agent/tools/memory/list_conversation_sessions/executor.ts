import { listConversationSessions } from
  "../../../context/conversation-session-reference.ts";
import type { ConversationSessionReferenceScope } from
  "../../../context/conversation-session-reference.ts";
import type { createMemoryToolHandlers } from "../shared.ts";

export function createListConversationSessionsToolHandler(
  input: Parameters<typeof createMemoryToolHandlers>[0],
) {
  return async (call: { args: Record<string, unknown> }) =>
    listConversationSessions({
      butlerData: input.butlerData,
      currentSessionId: input.sessionId ?? "butler/main",
      projectId: input.projectId,
      scope: sessionScope(call.args.scope),
      limit: typeof call.args.limit === "number" ? call.args.limit : undefined,
      includeArchived: call.args.include_archived === true,
      previewMessages: typeof call.args.preview_messages === "number"
        ? call.args.preview_messages
        : undefined,
    });
}

function sessionScope(value: unknown): ConversationSessionReferenceScope | undefined {
  return value === "current_project" || value === "all_sessions" ? value : undefined;
}
