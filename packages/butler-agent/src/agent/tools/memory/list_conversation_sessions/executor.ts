import {
  listConversationSessions,
} from "../../../context/conversation-session-reference.ts";
import {
  listConversationSessionsV2,
} from "../../../context/conversation-session-reference.ts";
import type {
  ConversationSessionReferenceScope,
} from "../../../context/conversation-session-reference.ts";
import type { createMemoryToolHandlers } from "../shared.ts";
import type { ButlerToolCall } from "../../types.ts";

export function createListConversationSessionsToolHandler(
  input: Parameters<typeof createMemoryToolHandlers>[0],
) {
  return async (call: ButlerToolCall) => {
    if (call.toolContractVersion === undefined) {
      return listConversationSessions({
        butlerData: input.butlerData,
        currentSessionId: input.sessionId ?? "butler/main",
        projectId: input.projectId,
        scope: sessionScope(call.args.scope),
        limit: typeof call.args.limit === "number"
          ? call.args.limit
          : undefined,
        includeArchived: call.args.include_archived === true,
        previewMessages: typeof call.args.preview_messages === "number"
          ? call.args.preview_messages
          : undefined,
      });
    }
    if ((call.toolContractVersion ?? 1) === 2) {
      if (!input.sessionId?.trim() || !input.turnId?.trim()) {
        throw new Error(
          "list_conversation_sessions v2 requires runtime session and turn binding",
        );
      }
      return listConversationSessionsV2({
        butlerData: input.butlerData,
        currentSessionId: input.sessionId,
        currentProjectId: input.projectId?.trim() || null,
        scope: call.args.scope as any,
        sessionIds: Array.isArray(call.args.session_ids)
          ? call.args.session_ids as string[]
          : undefined,
        projectFilter: call.args.project_filter as any,
        projectIds: Array.isArray(call.args.project_ids)
          ? call.args.project_ids as string[]
          : undefined,
        includeInternal: call.args.include_internal === true,
        sessionKind: call.args.session_kind as any,
        includeArchived: call.args.include_archived === true,
        previewMessages: typeof call.args.preview_messages === "number"
          ? call.args.preview_messages
          : undefined,
        limit: typeof call.args.limit === "number"
          ? call.args.limit
          : undefined,
        time: call.args.time as any,
        cursor: typeof call.args.cursor === "string"
          ? call.args.cursor
          : undefined,
      });
    }
    if (!input.sessionId?.trim()) {
      return listConversationSessions({
        butlerData: input.butlerData,
        currentSessionId: "butler/main",
        projectId: input.projectId,
        scope: sessionScope(call.args.scope),
        limit: typeof call.args.limit === "number"
          ? call.args.limit
          : undefined,
        includeArchived: call.args.include_archived === true,
        previewMessages: typeof call.args.preview_messages === "number"
          ? call.args.preview_messages
          : undefined,
      });
    }
    const normalized = listConversationSessionsV2({
      butlerData: input.butlerData,
      currentSessionId: input.sessionId,
      currentProjectId: input.projectId?.trim() || null,
      scope: call.args.scope === "current_project"
        ? "current_project"
        : "all_user_sessions",
      includeArchived: call.args.include_archived === true,
      previewMessages: typeof call.args.preview_messages === "number"
        ? call.args.preview_messages
        : undefined,
      limit: typeof call.args.limit === "number" ? call.args.limit : undefined,
    });
    if (normalized.ok !== true) return normalized;
    return { ...normalized, truncated: normalized.status === "partial" };
  };
}

function sessionScope(
  value: unknown,
): ConversationSessionReferenceScope | undefined {
  return value === "current_project" || value === "all_sessions"
    ? value
    : undefined;
}
