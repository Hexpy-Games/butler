import {
  boundedBufferSize,
  type PushStreamProxyHandle,
  type PushStreamProxyOptions,
  type StreamProxyStats,
} from "./stream-proxy-contract.ts";

/**
 * Producer-owned stream bridge for live events. It is deliberately separate
 * from the reader-owned bridge: the producer calls `push`, while this module
 * alone owns the downstream queue, abort listeners, and terminal cleanup.
 */
export function createPushStreamProxy<T>(
  options: PushStreamProxyOptions<T>,
): PushStreamProxyHandle<T> {
  const maxBufferedChunks = boundedBufferSize(options.maxBufferedChunks);
  const stats: StreamProxyStats = {
    upstreamReaderActive: false,
    listenerCount: 0,
    pendingChunks: 0,
  };
  let settle: (error?: unknown) => Promise<void> = async () => undefined;
  let push: (chunk: T) => void = () => undefined;
  let flushPendingForPull: () => void = () => undefined;
  let settled = false;

  const stream = new ReadableStream<T>({
    start(controller) {
      const pendingChunks: T[] = [];
      const detachSignals: Array<() => void> = [];
      const flushPending = () => {
        while (
          !settled &&
          pendingChunks.length > 0 &&
          (controller.desiredSize === null || controller.desiredSize > 0)
        ) {
          controller.enqueue(pendingChunks.shift()!);
        }
        stats.pendingChunks = pendingChunks.length;
      };
      flushPendingForPull = flushPending;

      settle = async (error?: unknown) => {
        if (settled) return;
        settled = true;
        let cleanupError: unknown;
        try {
          await options.onCancel?.();
        } catch (onCancelError) {
          cleanupError = onCancelError;
        } finally {
          // Producer cleanup is user code. A throwing callback must not skip
          // queue/listener teardown or make a second terminal path invoke it.
          pendingChunks.splice(0);
          stats.pendingChunks = 0;
          for (const detach of detachSignals.splice(0)) detach();
          stats.listenerCount = 0;
        }
        try {
          if (error !== undefined || cleanupError !== undefined) {
            // Preserve the primary upstream error when both cleanup and the
            // transport fail; otherwise expose cleanup failure to the reader.
            controller.error(error ?? cleanupError);
          } else {
            controller.close();
          }
        } catch {
          // The consumer may already have cancelled the stream.
        }
      };

      push = (chunk: T) => {
        if (settled) return;
        try {
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            if (pendingChunks.length >= maxBufferedChunks) {
              pendingChunks.splice(0);
              const marker = options.overflowChunk?.();
              if (marker !== undefined) pendingChunks.push(marker);
            } else {
              pendingChunks.push(chunk);
            }
            stats.pendingChunks = pendingChunks.length;
            return;
          }
          controller.enqueue(chunk);
          flushPending();
        } catch (pushError) {
          void settle(pushError);
        }
      };

      const cancel = () => {
        void settle();
      };
      const attachSignal = (signal: AbortSignal | undefined) => {
        if (!signal) return;
        if (signal.aborted) {
          cancel();
          return;
        }
        signal.addEventListener("abort", cancel, { once: true });
        stats.listenerCount += 1;
        detachSignals.push(() => {
          signal.removeEventListener("abort", cancel);
          stats.listenerCount = Math.max(0, stats.listenerCount - 1);
        });
      };
      attachSignal(options.clientDisconnectSignal);
      attachSignal(options.serverShutdownSignal);
    },
    pull() {
      // The producer owns delivery; pull only drains the bridge queue.
      flushPendingForPull();
    },
    cancel() {
      return settle();
    },
  });

  return {
    stream,
    push: (chunk) => push(chunk),
    close: () => settle(),
    stats: () => ({ ...stats }),
  };
}
