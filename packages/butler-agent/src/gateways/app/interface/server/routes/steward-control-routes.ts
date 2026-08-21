import { apiEnvelope } from "../../protocol/app-protocol.ts";
import { sessionHintForRow } from "../../../domain/sessions/index.ts";
import type { AppRouteContext } from "../server-types.ts";
import { json, parseJson, RequestError } from "../responses.ts";

export async function handleStewardControlRoutes(
  input: AppRouteContext,
): Promise<Response | null> {
  const matched = input.url.pathname.match(/^\/steward-relations\/([^/]+)\/cancel$/);
  if (!matched || input.request.method !== "POST") return null;
  const relationId = decodeURIComponent(matched[1]!);
  const body = await parseJson(input.request);
  const parentSessionId = requiredParentSessionId(body);
  const relation = input.stewardObserver.relationById(relationId);
  if (!relation || relation.parent_session_id !== sessionHintForRow(parentSessionId)) {
    throw new RequestError(404, "steward_relation_not_found", "Active Steward relation was not found.");
  }
  const snapshot = input.stewardObserver.snapshot(relation.child_session_id);
  const turnId = snapshot?.turns.find((turn) => turn.state === "admitted")?.id ?? null;
  if (!turnId || snapshot?.result) {
    throw new RequestError(409, "steward_relation_not_active", "Steward relation is not active.");
  }
  const requestedAt = new Date().toISOString();
  input.serviceClient.enqueueAppCancellation({
    chatId: relation.child_session_id,
    sessionId: relation.child_session_id,
    turnId,
    requestId: `app-steward-cancel:${relation.relation_id}:${turnId}`,
    requestedAt,
  }, {
    source: "app-steward-observer",
    relation_id: relation.relation_id,
  });
  return json(apiEnvelope({
    relation_id: relation.relation_id,
    child_turn_id: turnId,
    status: "cancelling",
  }), 202);
}

function requiredParentSessionId(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestError(400, "invalid_request", "Request body must be an object.");
  }
  const value = (body as Record<string, unknown>).parent_session_id;
  if (typeof value !== "string" || !value.trim()) {
    throw new RequestError(400, "parent_session_id_required", "parent_session_id is required.");
  }
  return value.trim();
}
