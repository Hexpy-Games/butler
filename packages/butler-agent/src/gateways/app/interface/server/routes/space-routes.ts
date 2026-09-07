import { apiEnvelope, isSpaceCommand } from "../../protocol/app-protocol.ts";
import type { AppRouteContext } from "../server-types.ts";
import { json, parseJson, RequestError } from "../responses.ts";

export async function handleSpaceRoutes(input: AppRouteContext): Promise<Response | null> {
  const { pathname } = input.url;
  const method = input.request.method;
  if (method === "POST" && pathname === "/internal/session-branches") {
    const body = await parseJson(input.request) as Record<string, unknown>;
    if (!body || typeof body !== "object") throw new RequestError(400, "branch_request_invalid", "대화 생성 요청을 확인해 주세요.");
    const result = await input.store.branchSessionFromTool(body,
      AbortSignal.any([input.request.signal, input.serverShutdownSignal]));
    if (typeof body.follow_up === "string" && body.follow_up.trim()) {
      await input.store.sendMessage({ chat_id: result.session.id, text: body.follow_up,
        client_message_id: `branch-followup-${body.request_id}`, queue_policy: "enqueue_if_busy" },
      input.responder, { deferResponderTurns: true });
    }
    return json(apiEnvelope({ session_id: result.session.id, title: result.session.title,
      project_id: result.session.project_id ?? null, context: result.seed.summary,
      source_session_id: result.seed.sourceSessionId, source_message_id: result.seed.sourceMessageId,
      started: typeof body.follow_up === "string" && Boolean(body.follow_up.trim()) }));
  }
  if (method === "POST" && pathname === "/space/branch-source") {
    const body = await parseJson(input.request) as { sessionId?: unknown };
    if (typeof body?.sessionId !== "string") throw new RequestError(400, "session_required", "대화를 선택해 주세요.");
    return json(apiEnvelope(input.store.getBranchSource(body.sessionId)));
  }
  if (method === "POST" && pathname === "/space/branches") {
    const body = await parseJson(input.request);
    return json(apiEnvelope(await input.store.branchSession(body as import("../../../../../foundation/session-branch.ts").SessionBranchRequest,
      AbortSignal.any([input.request.signal, input.serverShutdownSignal]))));
  }
  if (method === "GET" && pathname === "/space/branch-seed") {
    const sessionId = input.url.searchParams.get("session_id");
    if (!sessionId) throw new RequestError(400, "session_required", "대화를 선택해 주세요.");
    input.store.getSession(sessionId);
    return json(apiEnvelope({ seed: input.store.getSessionBranchSeed(sessionId) ?? null }));
  }
  if (method === "POST" && pathname === "/space/relocations") {
    const body = await parseJson(input.request) as Record<string, unknown> | null;
    if (!body || typeof body.operationId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/u.test(body.operationId) ||
      typeof body.sessionId !== "string" || !Number.isSafeInteger(body.expectedRevision) ||
      !(body.targetKey === null || typeof body.targetKey === "string") ||
      !["inside", "before", "after"].includes(String(body.position))) {
      throw new RequestError(400, "invalid_relocation", "옮길 대화와 이동 위치가 필요합니다.");
    }
    return json(apiEnvelope(await input.store.relocateSession({ operationId: body.operationId,
      sessionId: body.sessionId, expectedRevision: body.expectedRevision as number,
      targetKey: body.targetKey as string | null, position: body.position as "inside" | "before" | "after" })));
  }
  const group = pathname.match(/^\/space\/groups\/([^/]+)$/u);
  const action = method === "POST" ? {
    "/space/groups": "create", "/space/moves": "move", "/space/group-sessions": "group",
    "/space/undo": "undo", "/space/pins": "pin",
  }[pathname] : group && method === "PATCH" ? "rename" : group && method === "DELETE" ? "dissolve" : null;
  if (!action) return null;
  const body = await parseJson(input.request);
  const command = { ...(body && typeof body === "object" ? body : {}), action,
    ...(group ? { groupId: decodeURIComponent(group[1]!) } : {}) };
  if (!isSpaceCommand(command)) throw new RequestError(400, "invalid_space_command", "정리할 항목과 최신 목록 버전이 필요합니다.");
  return json(apiEnvelope(input.store.mutateSpace(command)));
}
