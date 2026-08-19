import {
  apiEnvelope,
  isSubsessionResultIngressRequest,
  subsessionResultClientMessageId,
  type SubsessionResultIngressResponse,
} from "../../protocol/app-protocol.ts";
import { parseJson, RequestError, json } from "../responses.ts";
import type { AppRouteContext } from "../server-types.ts";

/**
 * The only BTCC-to-App result ingress. It deliberately delegates admission to
 * the existing AppUserMessageTurnStore so queue, user-message, Turn, claim,
 * and transport projection ownership remains in the App gateway.
 */
export async function handleInternalResultRoutes(
  input: AppRouteContext,
): Promise<Response | null> {
  if (input.request.method !== "POST" || input.url.pathname !== "/internal/subsession-result") {
    return null;
  }
  const body = await parseJson(input.request);
  if (!isSubsessionResultIngressRequest(body)) {
    throw new RequestError(400, "invalid_request", "Invalid internal Steward result.");
  }
  const clientMessageId = subsessionResultClientMessageId(body.relation_id, body.result_id);
  const result = await input.store.sendMessage({
    chat_id: body.parent_chat_id,
    text: body.text,
    client_message_id: clientMessageId,
    model: body.model_ref,
    reasoning_effort: body.reasoning_effort,
    access_mode: body.access_mode,
    queue_policy: "enqueue_if_busy",
  }, undefined, {
    deferResponderTurns: true,
  });
  const response: SubsessionResultIngressResponse = {
    accepted: true,
    client_message_id: clientMessageId,
    ...(result.queued?.id ? { queued_message_id: result.queued.id } : {}),
    ...(result.turn?.id ? { turn_id: result.turn.id } : {}),
  };
  return json(apiEnvelope(response), 202);
}
