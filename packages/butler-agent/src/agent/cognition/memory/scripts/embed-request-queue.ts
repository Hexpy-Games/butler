/**
 * Serialized, bounded inference work for the Unix-socket embedding server.
 *
 * Keeping queue ownership separate from socket framing makes the memory bound
 * and release semantics testable without coupling them to a network server.
 */
export const DEFAULT_EMBED_MAX_QUEUE_REQUESTS = 64;
export const DEFAULT_EMBED_MAX_QUEUE_BYTES = 4 * 1024 * 1024;

export interface EmbedRequestQueueState {
  queuedRequests: number;
  queuedBytes: number;
  maxQueuedRequests: number;
  maxQueuedBytes: number;
}

export interface EmbedRequestQueue {
  enqueue<T>(fn: () => Promise<T>, requestBytes: number): Promise<T>;
  snapshot(): EmbedRequestQueueState;
}

function boundedPositiveOption(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

export function createEmbedRequestQueue(options: {
  maxQueueRequests?: number;
  maxQueueBytes?: number;
} = {}): EmbedRequestQueue {
  const maxQueuedRequests = boundedPositiveOption(
    options.maxQueueRequests,
    DEFAULT_EMBED_MAX_QUEUE_REQUESTS,
  );
  const maxQueuedBytes = boundedPositiveOption(
    options.maxQueueBytes,
    DEFAULT_EMBED_MAX_QUEUE_BYTES,
  );
  let queue: Promise<void> = Promise.resolve();
  let queuedRequests = 0;
  let queuedBytes = 0;
  const snapshot = (): EmbedRequestQueueState => ({
    queuedRequests,
    queuedBytes,
    maxQueuedRequests,
    maxQueuedBytes,
  });
  const enqueue = <T>(fn: () => Promise<T>, requestBytes: number): Promise<T> => {
    if (
      queuedRequests >= maxQueuedRequests ||
      queuedBytes + requestBytes > maxQueuedBytes
    ) {
      const error = new Error("Embedding request queue is full");
      Object.assign(error, { code: "embed_queue_full", retryable: true });
      return Promise.reject(error);
    }
    queuedRequests += 1;
    queuedBytes += requestBytes;
    const release = () => {
      queuedRequests = Math.max(0, queuedRequests - 1);
      queuedBytes = Math.max(0, queuedBytes - requestBytes);
    };
    const result = queue.then(fn);
    queue = result.then(release, release);
    return result;
  };
  return { enqueue, snapshot };
}
