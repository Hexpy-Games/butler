import { apiEnvelope } from "../../protocol/app-protocol.ts";
import { sessionHintForRow } from "../../../domain/sessions/index.ts";
import type { AppRouteContext } from "../server-types.ts";
import { json, parseJson, RequestError } from "../responses.ts";
import { stewardResumeRequestId } from
  "../../../../../agent/btcc/subsessions/index.ts";

export async function handleStewardControlRoutes(
  input: AppRouteContext,
): Promise<Response | null> {
  const matched = input.url.pathname.match(
    /^\/steward-relations\/([^/]+)\/(cancel|resume)$/,
  );
  if (!matched || input.request.method !== "POST") return null;
  const relationId = decodeURIComponent(matched[1]!);
  const action = matched[2]!;
  const body = await parseJson(input.request);
  const parentSessionId = requiredParentSessionId(body);
  const relation = input.stewardObserver.relationById(relationId);
  if (!relation || relation.parent_session_id !== sessionHintForRow(parentSessionId)) {
    throw new RequestError(404, "steward_relation_not_found", "Active Steward relation was not found.");
  }
  const snapshot = input.stewardObserver.snapshot(relation.child_session_id);
  const activeTurn = snapshot?.turns.find((turn) => turn.state === "admitted") ?? null;
  const turnId = activeTurn?.id ?? (action === "cancel" ? snapshot?.turns.at(-1)?.id : null);
  if (!turnId || snapshot?.result) {
    throw new RequestError(409, "steward_relation_not_active", "Steward relation is not active.");
  }
  const requestedAt = new Date().toISOString();
  if (action === "resume") {
    if (activeTurn?.recovery?.state !== "recoverable" ||
      !activeTurn.recovery.recovery_id) {
      throw new RequestError(409, "steward_relation_not_recoverable", "Steward relation is not recoverable.");
    }
    const requestId = stewardResumeRequestId(
      relation.relation_id,
      activeTurn.recovery.recovery_id,
    );
    const recovery = input.stewardObserver.recoverableTurns().find((candidate) =>
      candidate.relation.relation_id === relation.relation_id && candidate.turn_id === turnId,
    );
    if (!recovery) {
      throw new RequestError(409, "steward_relation_not_recoverable", "Steward relation is not recoverable.");
    }
    input.serviceClient.enqueueAppResume({
      chatId: relation.child_session_id,
      sessionId: relation.child_session_id,
      turnId,
      requestId,
      requestedAt,
      originalEventId: recovery.original_event_id,
      originalMessageId: recovery.original_message_id,
      originalMessage: recovery.original_message,
    }, {
      source: "app-steward-observer",
      relation_id: relation.relation_id,
    });
    return json(apiEnvelope({
      relation_id: relation.relation_id,
      child_turn_id: turnId,
      status: "resuming",
      request_id: requestId,
    }), 202);
  }
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
