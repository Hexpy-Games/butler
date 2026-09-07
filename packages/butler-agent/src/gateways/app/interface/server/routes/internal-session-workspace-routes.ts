import { apiEnvelope } from "../../protocol/app-protocol.ts";
import { json, RequestError } from "../responses.ts";
import type { AppRouteContext } from "../server-types.ts";

export async function handleInternalSessionWorkspaceRoutes(
  input: AppRouteContext,
): Promise<Response | null> {
  if (input.request.method === "GET" && input.url.pathname === "/internal/session-context-admission") {
    const sessionId = input.url.searchParams.get("session_id");
    const turnId = input.url.searchParams.get("turn_id");
    if (!sessionId || !turnId) throw new RequestError(400, "session_turn_required", "Session and turn are required.");
    input.store.assertSessionContextAdmission(sessionId, turnId);
    return json(apiEnvelope({ admitted: true }));
  }
  if (
    input.request.method !== "GET" ||
    input.url.pathname !== "/internal/session-workspace"
  ) {
    return null;
  }
  const sessionId = input.url.searchParams.get("session_id")?.trim();
  if (!sessionId) {
    throw new RequestError(400, "session_required", "Session id is required.");
  }
  return json(apiEnvelope({
    session_id: sessionId,
    workspace_path: input.store.getSessionWorkspacePath(sessionId),
  }));
}
