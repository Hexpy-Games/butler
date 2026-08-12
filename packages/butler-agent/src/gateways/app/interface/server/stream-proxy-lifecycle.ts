import {
  boundedBufferSize,
  type StreamProxyHandle,
  type StreamProxyOptions,
  type StreamProxyStats,
} from "./stream-proxy-contract.ts";

export type {
  PushStreamProxyHandle,
  PushStreamProxyOptions,
  StreamProxyHandle,
  StreamProxyOptions,
  StreamProxyStats,
} from "./stream-proxy-contract.ts";
export { createPushStreamProxy } from "./push-stream-proxy.ts";

/**
 * Reader-owned bounded ReadableStream bridge for tunnel/SSE adapters.
 * Downstream cancellation, upstream completion/failure, and shutdown converge
 * on one idempotent settlement path; the upstream reader lock is released on
 * every terminal path.
 */
export function createStreamProxy<T>(
  options: StreamProxyOptions<T>,
): StreamProxyHandle<T> {
  const maxBufferedChunks = boundedBufferSize(options.maxBufferedChunks);
  const stats: StreamProxyStats = {
    upstreamReaderActive: false,
    listenerCount: 0,
    pendingChunks: 0,
  };
  let settle: (error?: unknown) => Promise<void> = async () => undefined;
  let flushPendingForPull: () => void = () => undefined;
  const stream = new ReadableStream<T>({
    start(controller) {
      const pendingChunks: T[] = [];
      let reader: ReadableStreamDefaultReader<T> | undefined;
      let settled = false;
      let readerCancel: Promise<void> | undefined;
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

      const cancelReader = async () => {
        if (!reader || readerCancel) return readerCancel;
        const activeReader = reader;
        readerCancel = Promise.resolve(activeReader.cancel()).then(
          () => undefined,
          () => undefined,
        ).finally(() => {
          activeReader.releaseLock();
        });
        await readerCancel;
        return readerCancel;
      };

      settle = async (error?: unknown) => {
        if (settled) return;
        settled = true;
        pendingChunks.splice(0);
        stats.pendingChunks = 0;
        for (const detach of detachSignals.splice(0)) detach();
        stats.listenerCount = 0;
        await cancelReader();
        stats.upstreamReaderActive = false;
        try {
          if (error !== undefined) controller.error(error);
          else controller.close();
        } catch {
          // The consumer may already have cancelled the downstream stream.
        }
      };

      const attachSignal = (signal: AbortSignal | undefined) => {
        if (!signal) return;
        const abort = () => {
          void settle();
        };
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
        stats.listenerCount += 1;
        detachSignals.push(() => {
          signal.removeEventListener("abort", abort);
          stats.listenerCount = Math.max(0, stats.listenerCount - 1);
        });
      };
      attachSignal(options.clientDisconnectSignal);
      attachSignal(options.serverShutdownSignal);
      if (settled) return;

      const enqueue = (chunk: T) => {
        if (settled) return;
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
      };

      const run = async () => {
        try {
          reader = options.upstream.getReader();
          stats.upstreamReaderActive = true;
          while (!settled) {
            const result = await reader.read();
            if (result.done) {
              await settle();
              return;
            }
            enqueue(result.value);
          }
        } catch (error) {
          if (!settled) await settle(error);
        }
      };
      void run();
    },
    pull() {
      // The source loop owns reads; a pull merely lets a bounded queue drain.
      flushPendingForPull();
    },
    cancel() {
      return settle();
    },
  });

  return {
    stream,
    close: () => settle(),
    stats: () => ({ ...stats }),
  };
}
