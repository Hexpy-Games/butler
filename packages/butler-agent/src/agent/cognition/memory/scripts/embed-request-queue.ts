/** Serialized, bounded inference work for the embedding server. */
export const DEFAULT_EMBED_MAX_QUEUE_REQUESTS = 64;
export const DEFAULT_EMBED_MAX_QUEUE_BYTES = 4 * 1024 * 1024;

export type EmbedRequestClass = "interactive" | "background";
export type EmbedQueueEvent = {
  phase: "admitted" | "started" | "settled" | "cancelled";
  requestClass: EmbedRequestClass;
  waitMs: number;
  runMs: number | null;
  code: string | null;
  active: boolean;
};

export interface EmbedRequestQueueState {
  queuedRequests: number;
  queuedBytes: number;
  activeRequests: number;
  waitingRequests: number;
  maxQueuedRequests: number;
  maxQueuedBytes: number;
}

export interface EmbedRequestQueue {
  enqueue<T>(fn: () => Promise<T>, requestBytes: number, options?: {
    requestClass?: EmbedRequestClass;
    deadlineAt?: number;
    signal?: AbortSignal;
  }): Promise<T>;
  snapshot(): EmbedRequestQueueState;
}

function boundedPositiveOption(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

export function createEmbedRequestQueue(options: {
  maxQueueRequests?: number;
  maxQueueBytes?: number;
  onEvent?: (event: EmbedQueueEvent) => void;
} = {}): EmbedRequestQueue {
  const maxQueuedRequests = boundedPositiveOption(
    options.maxQueueRequests,
    DEFAULT_EMBED_MAX_QUEUE_REQUESTS,
  );
  const maxQueuedBytes = boundedPositiveOption(
    options.maxQueueBytes,
    DEFAULT_EMBED_MAX_QUEUE_BYTES,
  );
  type Item<T = unknown> = {
    fn: () => Promise<T>; bytes: number; requestClass: EmbedRequestClass; deadlineAt: number;
    signal?: AbortSignal; admittedAt: number; startedAt: number | null; released: boolean;
    callerSettled: boolean; resolve: (value: T) => void; reject: (error: Error) => void;
    deadlineTimer?: ReturnType<typeof setTimeout>; abort: () => void;
  };
  const interactive: Item[] = [];
  const background: Item[] = [];
  let active: Item | null = null;
  let queuedRequests = 0;
  let queuedBytes = 0;
  let consecutiveInteractiveStarts = 0;
  const snapshot = (): EmbedRequestQueueState => ({
    queuedRequests,
    queuedBytes,
    activeRequests: active ? 1 : 0,
    waitingRequests: interactive.length + background.length,
    maxQueuedRequests,
    maxQueuedBytes,
  });
  const emit = (item: Item, phase: EmbedQueueEvent["phase"], code: string | null) => {
    const now = performance.now();
    options.onEvent?.({ phase, requestClass: item.requestClass,
      waitMs: Math.max(0, (item.startedAt ?? now) - item.admittedAt),
      runMs: item.startedAt === null ? null : Math.max(0, now - item.startedAt),
      code, active: item.startedAt !== null });
  };
  const release = (item: Item) => {
    if (item.released) return;
    item.released = true;
    queuedRequests = Math.max(0, queuedRequests - 1);
    queuedBytes = Math.max(0, queuedBytes - item.bytes);
    if (item.deadlineTimer) clearTimeout(item.deadlineTimer);
    item.signal?.removeEventListener("abort", item.abort);
  };
  const queueError = (code: string) => Object.assign(new Error(code), { code, retryable: true });
  const rejectCaller = (item: Item, code: string) => {
    if (item.callerSettled) return;
    item.callerSettled = true;
    item.reject(queueError(code));
    emit(item, "cancelled", code);
  };
  const removeWaiting = (item: Item) => {
    const lane = item.requestClass === "interactive" ? interactive : background;
    const index = lane.indexOf(item);
    if (index < 0) return false;
    lane.splice(index, 1);
    return true;
  };
  const cancel = (item: Item, code: string) => {
    rejectCaller(item, code);
    if (item.startedAt === null && removeWaiting(item)) {
      release(item);
      void pump();
    }
  };
  const discardExpired = (lane: Item[]) => {
    while (lane[0] && (lane[0]!.deadlineAt <= Date.now() || lane[0]!.signal?.aborted)) {
      const item = lane.shift()!;
      rejectCaller(item, item.signal?.aborted ? "embed_request_cancelled" : "embed_request_deadline");
      release(item);
    }
  };
  const takeNext = (): Item | null => {
    discardExpired(interactive); discardExpired(background);
    if (background.length && (consecutiveInteractiveStarts >= 8 || !interactive.length)) {
      consecutiveInteractiveStarts = 0; return background.shift()!;
    }
    if (interactive.length) { consecutiveInteractiveStarts += 1; return interactive.shift()!; }
    if (background.length) { consecutiveInteractiveStarts = 0; return background.shift()!; }
    return null;
  };
  const pump = async (): Promise<void> => {
    if (active) return;
    const item = takeNext();
    if (!item) return;
    active = item;
    item.startedAt = performance.now();
    if (item.deadlineTimer) clearTimeout(item.deadlineTimer);
    emit(item, "started", null);
    try {
      const value = await item.fn();
      if (!item.callerSettled) { item.callerSettled = true; item.resolve(value); }
      emit(item, "settled", null);
    } catch (error) {
      const code = typeof (error as { code?: unknown })?.code === "string" ? String((error as { code: string }).code) : "embed_request_failed";
      if (!item.callerSettled) { item.callerSettled = true; item.reject(error instanceof Error ? error : queueError(code)); }
      emit(item, "settled", code);
    } finally {
      release(item); active = null; void pump();
    }
  };
  const enqueue = <T>(fn: () => Promise<T>, requestBytes: number, request: {
    requestClass?: EmbedRequestClass; deadlineAt?: number; signal?: AbortSignal;
  } = {}): Promise<T> => {
    if (
      queuedRequests >= maxQueuedRequests ||
      queuedBytes + requestBytes > maxQueuedBytes
    ) {
      return Promise.reject(queueError("embed_queue_full"));
    }
    const requestClass = request.requestClass ?? "interactive";
    const deadlineAt = request.deadlineAt ?? Number.POSITIVE_INFINITY;
    if (request.signal?.aborted) return Promise.reject(queueError("embed_request_cancelled"));
    if (deadlineAt <= Date.now()) return Promise.reject(queueError("embed_request_deadline"));
    return new Promise<T>((resolve, reject) => {
      const item = { fn, bytes: requestBytes, requestClass, deadlineAt, signal: request.signal,
        admittedAt: performance.now(), startedAt: null, released: false, callerSettled: false,
        resolve, reject, abort: () => cancel(item as Item, "embed_request_cancelled") } as Item<T>;
      queuedRequests += 1; queuedBytes += requestBytes;
      (requestClass === "interactive" ? interactive : background).push(item as Item);
      if (Number.isFinite(deadlineAt)) item.deadlineTimer = setTimeout(() => cancel(item as Item, "embed_request_deadline"), Math.max(0, deadlineAt - Date.now()));
      request.signal?.addEventListener("abort", item.abort, { once: true });
      emit(item as Item, "admitted", null); void pump();
    });
  };
  return { enqueue, snapshot };
}
