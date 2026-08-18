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

  const retryCurrent = turnActionMatch(input, "retry-current");
  if (retryCurrent) {
    return json(
      apiEnvelope(
        await input.store.retryTurnWithCurrentControls(
          retryCurrent.turnId,
          input.responder,
          {
            responderTimeoutMs: input.responderTimeoutMs,
            deferResponderTurns: true,
          },
        ),
      ),
      202,
    );
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
  if (Object.hasOwn(body, "authority_request_ref")) {
    throw new RequestError(
      400,
      "invalid_request",
      "Authority decisions must use the Allow endpoint.",
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
        limit: boundedPageParam(input.url.searchParams.get("limit"), 200),
        offset: boundedPageParam(input.url.searchParams.get("offset"), 0, 0),
        cursor: input.url.searchParams.get("cursor") ?? undefined,
      }),
    ),
  );
}

function boundedPageParam(
  value: string | null,
  fallback: number,
  minimum = 1,
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(200, Math.floor(parsed)))
    : fallback;
}

function messagesSinceCursor(input: AppRouteContext): Response {
  const chatId = input.url.searchParams.get("chat_id") ?? undefined;
  const cursor = Number(input.url.searchParams.get("cursor") ?? "0");
  const sessionId = chatId ?? "general";
  input.store.refreshSessionProjection(sessionId);

  const cursorFloor = Number.isFinite(cursor) ? cursor : 0;
  // `/messages?cursor=` is a delta contract, not a projection-window query.
  // The session view is intentionally bounded to the latest page, so filtering
  // it would silently drop deltas when a client has been offline for more than
  // one page. Read from the canonical cursor-aware store instead.
  const page = input.store.listProjectedMessagePage(sessionId, {
    ...(cursorFloor > 0 ? { afterCursor: cursorFloor } : {}),
  });
  const messages = page.items;

  return json(
    apiEnvelope<MessageListView>({
      chat_id: sessionId,
      messages,
      turn_progress: input.store.listTurnProgressSnapshotsForMessages(messages),
      next_cursor: page.nextCursor || maxCursor(
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
  action: "retry" | "retry-current" | "cancel",
): { turnId: string } | null {
  const match =
    input.request.method === "POST"
      ? input.url.pathname.match(new RegExp(`^/turns/([^/]+)/${action}$`, "u"))
      : null;
  return match ? { turnId: decodeURIComponent(match[1]!) } : null;
}
