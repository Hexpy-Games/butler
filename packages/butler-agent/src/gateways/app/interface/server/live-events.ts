import {
  APP_PROTOCOL_VERSION,
  type AppEventEnvelope,
} from "../protocol/app-protocol.ts";
import type { AppServerStore } from "../../application/store/app-server-store.ts";

export function liveEventsResponse(
  store: AppServerStore,
  cursor: number,
  options: {
    clientDisconnectSignal?: AbortSignal;
    serverShutdownSignal?: AbortSignal;
  } = {},
): Response {
  const maxReplayEvents = 200;
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const detachCloseSignals: Array<() => void> = [];
  let closed = false;

  const cleanup = (): boolean => {
    if (closed) return false;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    for (const detach of detachCloseSignals.splice(0)) detach();
    return true;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const closeStream = () => {
        if (!cleanup()) return;
        try {
          controller.close();
        } catch {
          // The client may already have closed the stream.
        }
      };
      for (const signal of [
        options.clientDisconnectSignal,
        options.serverShutdownSignal,
      ]) {
        if (!signal) continue;
        if (signal.aborted) {
          closeStream();
          return;
        }
        signal.addEventListener("abort", closeStream, { once: true });
        detachCloseSignals.push(() =>
          signal.removeEventListener("abort", closeStream),
        );
      }
      const writeText = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closeStream();
        }
      };
      const writeEvent = (event: AppEventEnvelope) =>
        writeText(formatSseEvent(event));
      let streamCursor = cursor;
      let replaying = true;
      const pendingLiveEvents: AppEventEnvelope[] = [];
      unsubscribe = store.subscribeEvents((event) => {
        if (replaying) {
          pendingLiveEvents.push(event);
          return;
        }
        if (event.id <= streamCursor) return;
        writeEvent(event);
        streamCursor = event.id;
      });
      const highWaterCursor = store.latestEventCursor();
      if (highWaterCursor - streamCursor > maxReplayEvents) {
        writeEvent(reconcileRequiredEvent(streamCursor, highWaterCursor));
        streamCursor = highWaterCursor;
      } else {
        for (const event of store.replayEvents(streamCursor)) {
          if (event.id > highWaterCursor) break;
          writeEvent(event);
          streamCursor = event.id;
        }
      }
      replaying = false;
      for (const event of pendingLiveEvents.sort(
        (left, right) => left.id - right.id,
      )) {
        if (event.id <= streamCursor) continue;
        writeEvent(event);
        streamCursor = event.id;
      }
      if (!closed) {
        heartbeat = setInterval(() => {
          try {
            writeText(": heartbeat\n\n");
          } catch {
            closeStream();
          }
        }, 15_000);
      }
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

function reconcileRequiredEvent(
  afterCursor: number,
  highWaterCursor: number,
): AppEventEnvelope {
  return {
    protocol_version: APP_PROTOCOL_VERSION,
    id: highWaterCursor,
    type: "stream.reconcile_required",
    created_at: new Date().toISOString(),
    payload: {
      after_cursor: afterCursor,
      high_water_cursor: highWaterCursor,
    },
  };
}

function formatSseEvent(event: AppEventEnvelope): string {
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}
