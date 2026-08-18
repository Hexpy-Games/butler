import { AuthorityRequestError } from "../../../../../agent/btcc/authority/index.ts";
import {
  apiEnvelope,
  type MessageSendRequest,
} from "../../protocol/app-protocol.ts";
import { sessionHintForRow } from "../../../domain/sessions/session-read-model.ts";
import { RequestError, json } from "../responses.ts";
import type { AppRouteContext } from "../server-types.ts";

export async function handleAuthorityRoutes(
  input: AppRouteContext,
): Promise<Response | null> {
  if (!input.url.pathname.startsWith("/authority-requests")) return null;
  const sessionId = input.url.searchParams.get("session_id")?.trim() || "general";
  const ownerSessionId = sessionHintForRow(sessionId);

  if (input.request.method === "GET" && input.url.pathname === "/authority-requests") {
    return json(apiEnvelope({
      session_id: sessionId,
      requests: input.authority.list({ ownerSessionId }),
    }));
  }

  const match = input.request.method === "POST"
    ? input.url.pathname.match(/^\/authority-requests\/([^/]+)\/allow$/u)
    : null;
  if (!match) return null;
  const requestRef = decodeURIComponent(match[1]!);
  let approved;
  try {
    approved = input.authority.allow({ ownerSessionId, requestRef });
  } catch (error) {
    if (error instanceof AuthorityRequestError) {
      throw new RequestError(404, "authority_request_not_found", "Authority request not found.");
    }
    throw error;
  }

  const chatId = chatIdFromSessionHint(approved.sourceSessionId);
  if (!chatId) {
    throw new RequestError(409, "authority_source_session_invalid", "Authority source session is not resumable.");
  }
  const queueInput: MessageSendRequest = {
    chat_id: chatId,
    text: approved.scheduleInputText,
    client_message_id: approved.scheduleClientMessageId,
    model: approved.modelRef,
    reasoning_effort: approved.reasoningEffort as MessageSendRequest["reasoning_effort"],
    access_mode: "ask_first",
    authority_request_ref: approved.requestRef,
  };
  try {
    await input.store.sendMessage(queueInput, undefined, {
      deferResponderTurns: true,
    });
    input.authority.markScheduled({
      ownerSessionId,
      requestRef: approved.requestRef,
      clientMessageId: approved.scheduleClientMessageId,
    });
  } catch (error) {
    if (error instanceof AuthorityRequestError) {
      throw new RequestError(409, "authority_schedule_identity_mismatch", "Authority schedule could not be recorded.");
    }
    throw error;
  }
  return json(apiEnvelope({
    request_ref: approved.requestRef,
    decision: "allowed",
    scheduled: true,
  }), 202);
}

function chatIdFromSessionHint(sessionId: string): string | null {
  const prefix = "butler/app-";
  if (!sessionId.startsWith(prefix)) return null;
  const chatId = sessionId.slice(prefix.length);
  return chatId || null;
}
