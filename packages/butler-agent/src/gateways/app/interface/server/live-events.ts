import {
  APP_PROTOCOL_VERSION,
  type AppEventEnvelope,
} from "../protocol/app-protocol.ts";
import type { AppServerStore } from "../../application/store/app-server-store.ts";
import { createPushStreamProxy } from "./push-stream-proxy.ts";

export function liveEventsResponse(
  store: AppServerStore,
  cursor: number,
  options: {
    clientDisconnectSignal?: AbortSignal;
    serverShutdownSignal?: AbortSignal;
  } = {},
): Response {
  const maxReplayEvents = 200;
  const maxBufferedEvents = 128;
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let replaying = true;
  let replayQueueOverflowed = false;
  const replayQueue = new Map<number, AppEventEnvelope>();

  const cleanup = (): boolean => {
    if (closed) return false;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    replayQueue.clear();
    replayQueueOverflowed = false;
    return true;
  };

  let streamCursor = cursor;
  const proxy = createPushStreamProxy({
    maxBufferedChunks: maxBufferedEvents,
    overflowChunk: () =>
      encoder.encode(
        formatSseEvent(
          reconcileRequiredEvent(streamCursor, store.latestEventCursor()),
        ),
      ),
    clientDisconnectSignal: options.clientDisconnectSignal,
    serverShutdownSignal: options.serverShutdownSignal,
    onCancel: () => {
      cleanup();
    },
  });

  const writeText = (text: string) => {
    if (!closed) proxy.push(encoder.encode(text));
  };
  const writeEvent = (event: AppEventEnvelope) =>
    writeText(formatSseEvent(event));
  if (options.clientDisconnectSignal?.aborted ||
    options.serverShutdownSignal?.aborted) {
    return new Response(proxy.stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }
  const emitEvent = (event: AppEventEnvelope) => {
    if (closed || event.id <= streamCursor) return;
    writeEvent(event);
    streamCursor = event.id;
  };
  // Subscribe before taking the high-water mark so no event can be lost. A
  // producer may synchronously invoke this callback; hold those events until
  // replay is emitted to preserve cursor order and deduplicate overlap.
  unsubscribe = store.subscribeEvents((event) => {
    if (closed || event.id <= streamCursor) return;
    if (replaying) {
      if (replayQueue.size >= maxReplayEvents) {
        replayQueueOverflowed = true;
        replayQueue.clear();
      } else if (!replayQueueOverflowed) {
        replayQueue.set(event.id, event);
      }
      return;
    }
    emitEvent(event);
  });
  const highWaterCursor = store.latestEventCursor();
  if (highWaterCursor - streamCursor > maxReplayEvents) {
    writeEvent(reconcileRequiredEvent(streamCursor, highWaterCursor));
    streamCursor = highWaterCursor;
  } else {
    const replayEvents = store.replayEvents(streamCursor);
    if (replayEvents[0] && replayEvents[0].id > streamCursor + 1) {
      writeEvent(reconcileRequiredEvent(streamCursor, highWaterCursor));
      streamCursor = highWaterCursor;
    } else {
      for (const event of replayEvents) {
        if (event.id > highWaterCursor) break;
        emitEvent(event);
      }
    }
  }
  if (!closed) {
    if (replayQueueOverflowed) {
      const currentHighWater = store.latestEventCursor();
      writeEvent(reconcileRequiredEvent(streamCursor, currentHighWater));
      streamCursor = currentHighWater;
    } else {
      const queued = [...replayQueue.values()].sort((left, right) => left.id - right.id);
      for (const event of queued) emitEvent(event);
    }
  }
  replaying = false;
  replayQueue.clear();
  replayQueueOverflowed = false;
  if (!closed) {
    heartbeat = setInterval(() => {
      if (!closed) writeText(": heartbeat\n\n");
    }, 15_000);
  }

  return new Response(proxy.stream, {
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
