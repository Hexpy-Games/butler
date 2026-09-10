import {
  type ConversationSessionReferenceScope,
  readConversationSession,
} from "../../../context/conversation-session-reference.ts";
import type { ConversationContextDirection } from "../../../context/conversation-context.ts";
import type { createMemoryToolHandlers } from "../shared.ts";
import type { ButlerToolCall } from "../../types.ts";

export function createReadConversationSessionToolHandler(
  input: Parameters<typeof createMemoryToolHandlers>[0],
) {
  return async (call: ButlerToolCall) => {
    try {
      const version = call.toolContractVersion ?? 1;
      if (
        version === 2 && (!input.sessionId?.trim() || !input.turnId?.trim())
      ) {
        return { ok: false, code: "invalid_scope", diagnostics: ["runtime_binding_required"] };
      }
      const sourceRef = typeof call.args.source_ref === "string"
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
        return {
          ok: false,
          code: "invalid_arguments",
          diagnostics: [conversationSessionId ? "source_locator_conflict" : "source_locator_required"],
        };
      }
      if (version === 1 && !conversationSessionId) {
        throw new Error(
          "read_conversation_session requires conversation_session_id",
        );
      }
      if (
        version === 2 && sourceRef && (
          call.args.anchor_message_id !== undefined ||
          call.args.direction !== undefined ||
          call.args.include_tools !== undefined || call.args.limit !== undefined
        )
      ) {
        return { ok: false, code: "invalid_arguments", diagnostics: ["source_mode_options_not_allowed"] };
      }
      if (version === 2 && call.args.cursor !== undefined && !sourceRef) {
        return { ok: false, code: "invalid_arguments", diagnostics: ["session_cursor_not_allowed"] };
      }
      const common = {
        butlerData: input.butlerData,
        currentSessionId: input.sessionId ?? "butler/main",
        conversationSessionId,
        projectId: input.projectId,
        scope: sessionScope(call.args.scope),
        sessionIds: Array.isArray(call.args.session_ids)
          ? call.args.session_ids as string[]
          : undefined,
        projectFilter: call.args.project_filter as any,
        projectIds: Array.isArray(call.args.project_ids)
          ? call.args.project_ids as string[]
          : undefined,
        includeInternal: call.args.include_internal === true,
        anchorMessageId: typeof call.args.anchor_message_id === "string"
          ? call.args.anchor_message_id
          : undefined,
        direction: direction(call.args.direction),
        limit: typeof call.args.limit === "number"
          ? call.args.limit
          : undefined,
        maxChars: typeof call.args.max_chars === "number"
          ? call.args.max_chars
          : undefined,
        includeTools: call.args.include_tools === true,
        cursor: typeof call.args.cursor === "string"
          ? call.args.cursor
          : undefined,
        contractVersion: version as 1 | 2,
      };
      const result = version === 2 && sourceRef
        ? readConversationSession({ ...common, sourceRef })
        : readConversationSession({ ...common, sourceRef: undefined });
      if (version === 2 && !result.ok) {
        return { ok: false, code: "invalid_scope", diagnostics: [] };
      }
      return result;
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      const normalizedCode = code === "memory_source_not_found"
        ? "source_not_found"
        : code === "memory_source_changed"
        ? "source_changed"
        : code;
      if (
        versionForFailure(call) === 2 &&
        [
          "source_not_found",
          "source_changed",
          "stale_cursor",
          "invalid_scope",
          "invalid_arguments",
          "invalid_cursor",
          "invalid_integer",
        ].includes(normalizedCode)
      ) {
        return {
          ok: false,
          code: normalizedCode === "invalid_integer" ||
              normalizedCode === "invalid_cursor"
            ? "invalid_arguments"
            : normalizedCode,
          diagnostics: normalizedCode === "invalid_arguments" ||
              normalizedCode === "invalid_integer" || normalizedCode === "invalid_cursor"
            ? [normalizedCode]
            : [],
        };
      }
      if (versionForFailure(call) === 2) {
        return {
          ok: false,
          code: "backend_unavailable",
          diagnostics: ["conversation_store_unavailable"],
        };
      }
      throw error;
    }
  };
}

function versionForFailure(call: ButlerToolCall): number {
  return call.toolContractVersion ?? 1;
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
