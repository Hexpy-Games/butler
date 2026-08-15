import {
  apiEnvelope,
  isQueueMessageRequest,
  type SessionQueueView,
  type UpdateQueuedMessageRequest,
} from "../../protocol/app-protocol.ts";
import { json, parseJson, RequestError } from "../responses.ts";
import type { AppRouteContext } from "../server-types.ts";

export async function handleSessionQueueRoutes(
  input: AppRouteContext,
): Promise<Response | null> {
  if (input.request.method === "GET" && input.url.pathname === "/session-queue") {
    return json(
      apiEnvelope<SessionQueueView>(
        input.store.listSessionQueue(sessionIdOrGeneral(input)),
      ),
    );
  }

  if (input.request.method === "POST" && input.url.pathname === "/session-queue") {
    const body = await parseJson(input.request);
    if (!isQueueMessageRequest(body)) {
      throw new RequestError(
        400,
        "invalid_request",
        "Queued message text is required.",
      );
    }
    return json(apiEnvelope(await input.store.createQueuedMessage(strictQueueMessageRequest(body))), 202);
  }

  const queuedMessageId = queuedMessageIdFromPath(input);
  if (!queuedMessageId) return null;

  if (input.request.method === "PATCH") {
    const body = await parseJson(input.request);
    return json(
      apiEnvelope(
        await input.store.updateQueuedMessage(
          queuedMessageId,
          body as UpdateQueuedMessageRequest,
        ),
      ),
    );
  }

  if (input.request.method === "DELETE") {
    return json(apiEnvelope(input.store.deleteQueuedMessage(queuedMessageId)));
  }
  return null;
}

function strictQueueMessageRequest(
  body: import("../../protocol/app-protocol.ts").QueueMessageRequest,
): import("../../protocol/app-protocol.ts").QueueMessageRequest {
  return {
    ...(typeof body.chat_id === "string" ? { chat_id: body.chat_id } : {}),
    ...(typeof body.text === "string" ? { text: body.text } : {}),
    ...(Array.isArray(body.attachments) ? { attachments: body.attachments.map((item) => ({ file_id: item.file_id })) } : {}),
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    ...(body.reasoning_effort !== undefined ? { reasoning_effort: body.reasoning_effort } : {}),
    ...(body.access_mode !== undefined ? { access_mode: body.access_mode } : {}),
    ...(typeof body.plan_mode === "boolean" ? { plan_mode: body.plan_mode } : {}),
  };
}

function sessionIdOrGeneral(input: AppRouteContext): string {
  return (
    input.url.searchParams.get("session_id") ??
    input.url.searchParams.get("sessionId") ??
    "general"
  );
}

function queuedMessageIdFromPath(input: AppRouteContext): string | null {
  if (input.request.method !== "PATCH" && input.request.method !== "DELETE") {
    return null;
  }
  const match = input.url.pathname.match(/^\/session-queue\/([^/]+)$/u);
  return match ? decodeURIComponent(match[1]!) : null;
}
