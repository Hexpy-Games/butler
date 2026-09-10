import { createMemoryToolHandlers } from "../shared.ts";
import { queryMemoryV2 } from "../../../cognition/memory/exact-query.ts";
import type { ButlerToolCall } from "../../types.ts";

export function createQueryMemoryToolHandler(
  input: Parameters<typeof createMemoryToolHandlers>[0],
) {
  const legacy = createMemoryToolHandlers(input).query_memory;
  return (call: ButlerToolCall) => {
    if (call.toolContractVersion === undefined) return legacy(call);
    if ((call.toolContractVersion ?? 1) !== 2) {
      if (
        call.args.include_transcript_recovery === true ||
        call.args.include_placeholders === true
      ) return legacy(call);
      if (!input.sessionId?.trim() || !input.turnId?.trim()) {
        throw new Error(
          "query_memory v1 requires runtime session and turn binding",
        );
      }
      const mode = call.args.match_mode === "phrase"
        ? "phrase"
        : call.args.match_mode === "all"
        ? "all"
        : "any";
      const query = typeof call.args.query === "string"
        ? call.args.query
        : undefined;
      const normalizedMode = query === undefined ? "phrase" : mode;
      const terms = normalizedMode === "phrase"
        ? undefined
        : query?.trim().split(/\s+/u).filter(Boolean);
      const session =
        typeof call.args.session_id === "string" && call.args.session_id.trim()
          ? call.args.session_id.trim()
          : input.sessionId;
      const time = legacyTime(call.args.date_from, call.args.date_to);
      const result = queryMemoryV2({
        butlerData: input.butlerData,
        currentSessionId: input.sessionId,
        currentProjectId: input.projectId?.trim() || null,
        query: normalizedMode === "phrase" ? query : undefined,
        terms,
        matchMode: normalizedMode,
        caseSensitive: true,
        speaker: call.args.speaker as any,
        eventKind: call.args.event_kind as any,
        order: call.args.order as any,
        time,
        limit: typeof call.args.limit === "number"
          ? call.args.limit
          : undefined,
        scope: "all_user_sessions",
        sessionIds: call.args.scope === "session" ? [session] : [],
        projectFilter: "any",
        projectIds: [],
        includeInternal: call.args.include_internal === true,
        allowEmptyMatch: query === undefined,
      });
      if (!result.ok) return result;
      return {
        ...result,
        results: result.results.map((item) => ({
          ...item,
          event_id: item.conversation_message_id,
          timestamp: item.created_at,
        })),
      };
    }
    if (!input.sessionId?.trim() || !input.turnId?.trim()) {
      throw new Error(
        "query_memory v2 requires runtime session and turn binding",
      );
    }
    return queryMemoryV2({
      butlerData: input.butlerData,
      currentSessionId: input.sessionId,
      currentProjectId: input.projectId?.trim() || null,
      query: typeof call.args.query === "string" ? call.args.query : undefined,
      terms: Array.isArray(call.args.terms)
        ? call.args.terms as string[]
        : undefined,
      matchMode: call.args.match_mode as any,
      caseSensitive: typeof call.args.case_sensitive === "boolean"
        ? call.args.case_sensitive
        : undefined,
      speaker: call.args.speaker as any,
      eventKind: call.args.event_kind as any,
      order: call.args.order as any,
      time: call.args.time as any,
      limit: typeof call.args.limit === "number" ? call.args.limit : undefined,
      cursor: typeof call.args.cursor === "string"
        ? call.args.cursor
        : undefined,
      scope: call.args.scope as any,
      sessionIds: Array.isArray(call.args.session_ids)
        ? call.args.session_ids as string[]
        : undefined,
      projectFilter: call.args.project_filter as any,
      projectIds: Array.isArray(call.args.project_ids)
        ? call.args.project_ids as string[]
        : undefined,
      includeInternal: call.args.include_internal === true,
    });
  };
}

function legacyTime(
  from: unknown,
  to: unknown,
): { from: string; to: string; basis: "conversation" } | undefined {
  if (from === undefined && to === undefined) return undefined;
  const fromMs = from === undefined
      ? Date.parse("1970-01-01T00:00:00.000Z")
      : typeof from === "string"
      ? Date.parse(from)
      : Number.NaN,
    toMs = to === undefined
      ? Date.parse("9999-12-31T23:59:59.998Z")
      : typeof to === "string"
      ? Date.parse(to)
      : Number.NaN;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new Error("invalid_arguments");
  }
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs + 1).toISOString(),
    basis: "conversation",
  };
}
