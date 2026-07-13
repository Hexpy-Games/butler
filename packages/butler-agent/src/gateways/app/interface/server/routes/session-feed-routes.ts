import {
  apiEnvelope,
  isMessageSendRequest,
  type MessageListView,
  type TurnListView,
  type WorkerActivityListView,
} from "../../protocol/app-protocol.ts";
import { maxCursor } from "../route-params.ts";
import { json, parseJson, RequestError } from "../responses.ts";
import type { AppRouteContext } from "../server-types.ts";

export async function handleSessionFeedRoutes(
  input: AppRouteContext,
): Promise<Response | null> {
  const workerActivity = workerActivityMatch(input);
  if (workerActivity) return workerActivity;

  if (input.request.method === "GET" && input.url.pathname === "/messages") {
    return messagesSinceCursor(input);
  }
  if (input.request.method === "GET" && input.url.pathname === "/turns") {
    return turnsSinceCursor(input);
  }

  const retry = turnActionMatch(input, "retry");
  if (retry) {
    return json(
      apiEnvelope(
        await input.store.retryTurn(retry.turnId, input.responder, {
          responderTimeoutMs: input.responderTimeoutMs,
          deferResponderTurns: true,
        }),
      ),
      202,
    );
  }

  const cancel = turnActionMatch(input, "cancel");
  if (cancel) {
    return json(apiEnvelope(await input.store.cancelTurn(cancel.turnId)), 202);
  }

  if (input.request.method !== "POST" || input.url.pathname !== "/messages") {
    return null;
  }
  const body = await parseJson(input.request);
  if (!isMessageSendRequest(body)) {
    throw new RequestError(
      400,
      "invalid_request",
      "Message text is required.",
    );
  }

  const chatId = body.chat_id?.trim() || "general";
  if (!input.messageRateLimiter.consume(`messages:${chatId}`)) {
    throw new RequestError(
      429,
      "rate_limited",
      "Too many messages. Please wait before sending again.",
    );
  }
  return json(
    apiEnvelope(
      await input.store.sendMessage(body, input.responder, {
        responderTimeoutMs: input.responderTimeoutMs,
        deferResponderTurns: true,
      }),
    ),
    202,
  );
}

function workerActivityMatch(input: AppRouteContext): Response | null {
  const match =
    input.request.method === "GET"
      ? input.url.pathname.match(
          /^\/sessions\/([^/]+)\/worker-activity(?:\/history)?$/u,
        )
      : null;
  if (!match) return null;

  const sessionId = decodeURIComponent(match[1]!);
  input.store.refreshSessionProjection(sessionId);
  return json(
    apiEnvelope<WorkerActivityListView>(
      input.store.listWorkerActivity({
        sessionId,
        includeHistory: input.url.pathname.endsWith("/history"),
      }),
    ),
  );
}

function messagesSinceCursor(input: AppRouteContext): Response {
  const chatId = input.url.searchParams.get("chat_id") ?? undefined;
  const cursor = Number(input.url.searchParams.get("cursor") ?? "0");
  const sessionId = chatId ?? "general";
  input.store.refreshSessionProjection(sessionId);

  const cursorFloor = Number.isFinite(cursor) ? cursor : 0;
  const messages = input.store
    .getSessionView(sessionId)
    .messages.filter((message) => Number(message.cursor ?? 0) > cursorFloor);

  return json(
    apiEnvelope<MessageListView>({
      chat_id: sessionId,
      messages,
      turn_progress: input.store.listTurnProgressSnapshotsForMessages(messages),
      next_cursor: maxCursor(
        messages.map((message) => message.cursor),
        cursorFloor,
      ),
    }),
  );
}

function turnsSinceCursor(input: AppRouteContext): Response {
  const chatId = input.url.searchParams.get("chat_id") ?? undefined;
  const cursor = Number(input.url.searchParams.get("cursor") ?? "0");
  const cursorFloor = Number.isFinite(cursor) ? cursor : 0;
  input.store.refreshSessionProjection(chatId ?? "general");

  const turns = input.store.listTurns(chatId, cursorFloor);
  return json(
    apiEnvelope<TurnListView>({
      chat_id: chatId ?? "general",
      turns,
      next_cursor: turns.at(-1)?.cursor ?? cursorFloor,
    }),
  );
}

function turnActionMatch(
  input: AppRouteContext,
  action: "retry" | "cancel",
): { turnId: string } | null {
  const match =
    input.request.method === "POST"
      ? input.url.pathname.match(new RegExp(`^/turns/([^/]+)/${action}$`, "u"))
      : null;
  return match ? { turnId: decodeURIComponent(match[1]!) } : null;
}
