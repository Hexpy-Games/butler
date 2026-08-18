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
    ? input.url.pathname.match(/^\/authority-requests\/([^/]+)\/(allow|deny|modify)$/u)
    : null;
  if (!match) return null;
  const requestRef = decodeURIComponent(match[1]!);
  const decisionAction = match[2];
  let decision;
  try {
    if (decisionAction === "modify") {
      decision = input.authority.modify({
        ownerSessionId,
        requestRef,
        alternativeInput: await modifyInput(input.request),
      });
    } else {
      decision = decisionAction === "deny"
        ? input.authority.deny({ ownerSessionId, requestRef })
        : input.authority.allow({ ownerSessionId, requestRef });
    }
  } catch (error) {
    if (error instanceof AuthorityRequestError) {
      if (error.code === "authority_modify_input_missing" ||
          error.code === "authority_modify_input_too_large") {
        throw new RequestError(400, error.code, "Modify instruction is invalid.");
      }
      if (error.code === "authority_modify_identity_mismatch") {
        throw new RequestError(409, error.code, "Modify instruction conflicts with the stored decision.");
      }
      throw new RequestError(404, "authority_request_not_found", "Authority request not found.");
    }
    throw error;
  }

  const chatId = chatIdFromSessionHint(decision.sourceSessionId);
  if (!chatId) {
    throw new RequestError(409, "authority_source_session_invalid", "Authority source session is not resumable.");
  }
  const queueInput: MessageSendRequest = {
    chat_id: chatId,
    text: decision.scheduleInputText,
    client_message_id: decision.scheduleClientMessageId,
    model: decision.modelRef,
    reasoning_effort: decision.reasoningEffort as MessageSendRequest["reasoning_effort"],
    access_mode: "ask_first",
    authority_request_ref: decision.requestRef,
  };
  try {
    const scheduled = await input.store.sendMessage(queueInput, undefined, {
      deferResponderTurns: true,
    });
    const scheduledTurnId = scheduled.turn?.id ?? scheduled.queued?.turn_id;
    if (!scheduledTurnId) {
      throw new RequestError(409, "authority_source_turn_missing", "Authority source Turn could not be scheduled.");
    }
    input.authority.markScheduled({
      ownerSessionId,
      requestRef: decision.requestRef,
      clientMessageId: decision.scheduleClientMessageId,
      turnId: scheduledTurnId,
    });
  } catch (error) {
    if (error instanceof AuthorityRequestError) {
      throw new RequestError(409, "authority_schedule_identity_mismatch", "Authority schedule could not be recorded.");
    }
    throw error;
  }
  return json(apiEnvelope({
    request_ref: decision.requestRef,
    decision: decision.decision,
    scheduled: true,
  }), 202);
}

async function modifyInput(request: Request): Promise<string> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new RequestError(400, "authority_modify_input_missing", "Modify instruction is invalid.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestError(400, "authority_modify_input_missing", "Modify instruction is invalid.");
  }
  const record = body as Record<string, unknown>;
  const alternative = record.alternative ?? record.instruction;
  if (typeof alternative !== "string" || !alternative.trim()) {
    throw new RequestError(400, "authority_modify_input_missing", "Modify instruction is invalid.");
  }
  return alternative;
}

function chatIdFromSessionHint(sessionId: string): string | null {
  const prefix = "butler/app-";
  if (!sessionId.startsWith(prefix)) return null;
  const chatId = sessionId.slice(prefix.length);
  return chatId || null;
}
