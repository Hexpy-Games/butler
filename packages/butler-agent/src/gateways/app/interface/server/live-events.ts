import type { AppEventEnvelope } from "../protocol/app-protocol.ts";
import type { AppServerStore } from "../../application/store/app-server-store.ts";

export function liveEventsResponse(
  store: AppServerStore,
  cursor: number,
): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const closeStream = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // The client may already have closed the stream.
        }
      };
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
      unsubscribe = store.subscribeEvents((event) => {
        if (event.id > cursor) writeEvent(event);
      });
      for (const event of store.replayEvents(cursor)) writeEvent(event);
      if (!closed) {
        heartbeat = setInterval(() => {
          try {
            store.syncAllAppTransportEvents();
            writeText(": heartbeat\n\n");
          } catch {
            closeStream();
          }
        }, 1_000);
      }
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
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

function formatSseEvent(event: AppEventEnvelope): string {
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}
