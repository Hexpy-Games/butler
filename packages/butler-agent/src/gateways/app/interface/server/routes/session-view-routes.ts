import {
  APP_PROTOCOL_VERSION,
  apiEnvelope,
  type ContextDetailsView,
  type SessionSummaryView,
  type SessionView,
} from "../../protocol/app-protocol.ts";
import { json, RequestError } from "../responses.ts";
import type { AppRouteContext } from "../server-types.ts";
import {
  decodeSessionCursor,
  normalizeCursor,
} from "../../../domain/sessions/session-message-page.ts";

export function handleSessionViewRoutes(
  input: AppRouteContext,
): Response | null {
  if (input.request.method !== "GET") return null;

  if (input.url.pathname === "/session-summary") {
    const sessionId = requiredSessionId(input);
    input.store.refreshSessionProjection(sessionId);
    return json(
      apiEnvelope<SessionSummaryView>(input.store.getSessionSummary(sessionId)),
    );
  }

  if (input.url.pathname === "/session-view") {
    const sessionId = requiredSessionId(input);
    input.store.refreshSessionProjection(sessionId);
    return json(
      apiEnvelope<SessionView>(
        input.store.getSessionView(
          sessionId,
          sessionViewPageFromUrl(input.url, sessionId),
        ),
      ),
    );
  }

  if (input.url.pathname === "/context-details") {
    const sessionId = requiredSessionId(input);
    input.store.refreshSessionProjection(sessionId);
    return json(
      apiEnvelope<ContextDetailsView>(input.store.getContextDetails(sessionId)),
    );
  }

  if (input.url.pathname === "/artifacts") {
    const sessionId = requiredSessionId(input);
    input.store.refreshSessionProjection(sessionId);
    return json(
      apiEnvelope({ artifacts: input.store.listArtifacts(sessionId) }),
    );
  }

  if (input.url.pathname === "/transcript-export") {
    return transcriptExportResponse(input.store.exportTranscriptStream(requiredSessionId(input)));
  }
  return null;
}

/**
 * Keep the public JSON envelope unchanged while emitting the full transcript
 * incrementally. The store owns bounded page traversal; this writer owns only
 * the small JSON framing and current message count.
 */
export function transcriptExportResponse(stream: {
  session_id: string;
  format: "markdown";
  filename: string;
  generated_at: string;
  chunks: Iterable<{ text: string; message_count?: number }>;
}): Response {
  const encoder = new TextEncoder();
  const iterator = stream.chunks[Symbol.iterator]();
  let phase: "prefix" | "chunks" | "suffix" | "done" = "prefix";
  let messageCount = 0;
  const prefix =
    `{"protocol_version":${JSON.stringify(APP_PROTOCOL_VERSION)},"data":{` +
    `"session_id":${JSON.stringify(stream.session_id)},` +
    `"format":${JSON.stringify(stream.format)},` +
    `"filename":${JSON.stringify(stream.filename)},` +
    "\"content\":\"";
  const suffix = () =>
    `","message_count":${messageCount},` +
    `"generated_at":${JSON.stringify(stream.generated_at)}}}`;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      try {
        if (phase === "prefix") {
          phase = "chunks";
          controller.enqueue(encoder.encode(prefix));
          return;
        }
        if (phase === "chunks") {
          const next = iterator.next();
          if (!next.done) {
            const escaped = JSON.stringify(next.value.text);
            controller.enqueue(encoder.encode(escaped.slice(1, -1)));
            messageCount += next.value.message_count ?? 0;
            return;
          }
          phase = "suffix";
        }
        if (phase === "suffix") {
          phase = "done";
          controller.enqueue(encoder.encode(suffix()));
          controller.close();
        }
      } catch (error) {
        phase = "done";
        controller.error(error);
      }
    },
    cancel() {
      phase = "done";
      iterator.return?.();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function sessionViewPageFromUrl(url: URL, sessionId: string): {
  afterCursor?: number;
  afterCursorToken?: string;
  beforeCursor?: number;
  beforeCursorToken?: string;
  limit?: number;
} {
  const rawCursorKeys = [
    "cursor",
    "after_cursor",
    "before_cursor",
    "beforeCursor",
  ] as const;
  if (rawCursorKeys.some((key) => url.searchParams.has(key))) {
    throw new RequestError(
      409,
      "session_cursor_resync_required",
      "Session view cursor is invalid or expired; reload the session.",
    );
  }
  const afterCursorToken = url.searchParams.get("cursor_token") ?? undefined;
  const beforeCursorToken =
    url.searchParams.get("before_cursor_token") ?? undefined;
  const decodedAfter = afterCursorToken
    ? decodeSessionCursor(afterCursorToken, sessionId)
    : undefined;
  const decodedBefore = beforeCursorToken
    ? decodeSessionCursor(beforeCursorToken, sessionId)
    : undefined;
  if (afterCursorToken && decodedAfter === undefined) {
    throw new RequestError(
      409,
      "session_cursor_resync_required",
      "Session view cursor is invalid or expired; reload the session.",
    );
  }
  if (beforeCursorToken && decodedBefore === undefined) {
    throw new RequestError(
      409,
      "session_cursor_resync_required",
      "Session view cursor is invalid or expired; reload the session.",
    );
  }
  const requestedLimit = normalizeCursor(url.searchParams.get("limit"));
  return {
    ...(decodedBefore !== undefined
      ? { beforeCursor: decodedBefore, beforeCursorToken }
      : {}),
    ...(decodedBefore === undefined &&
    decodedAfter !== undefined
      ? {
          afterCursor: decodedAfter,
          ...(afterCursorToken ? { afterCursorToken } : {}),
        }
      : {}),
    ...(requestedLimit !== undefined ? { limit: requestedLimit } : {}),
  };
}

function requiredSessionId(input: AppRouteContext): string {
  const sessionId =
    input.url.searchParams.get("session_id") ??
    input.url.searchParams.get("sessionId");
  if (sessionId) return sessionId;
  throw new RequestError(400, "session_required", "Session id is required.");
}
