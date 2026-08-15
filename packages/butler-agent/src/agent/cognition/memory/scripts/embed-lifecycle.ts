import type { FeatureExtractionPipeline } from "@huggingface/transformers";

export const DEFAULT_EMBED_IDLE_RECYCLE_MS = 15 * 60 * 1_000;
export const MAX_EMBED_IDLE_RECYCLE_MS = 24 * 60 * 60 * 1_000;

type PipelineLoader = () => Promise<FeatureExtractionPipeline>;

export type EmbedHealthState = "starting" | "ready" | "busy" | "recycling" | "unavailable";

export interface EmbedHealthSnapshot {
  status: EmbedHealthState;
  socket: string;
  model_loaded: boolean;
  active_requests: number;
  idle_recycle_ms: number;
  uptime: number;
  queued_requests?: number;
  queued_bytes?: number;
  max_queued_requests?: number;
  max_queued_bytes?: number;
}

export interface EmbeddingLifecycle {
  health(): Omit<EmbedHealthSnapshot, "socket" | "uptime">;
  markReady(): void;
  markUnavailable?(): void;
}

export interface LazyEmbeddingOptions {
  loadPipeline: PipelineLoader;
  log?: (message: string) => void;
  /** Idle boundary after which the model is unloaded/recycled. `0` disables it. */
  idleRecycleMs?: number;
  /** Called after the model reference has been dropped. Production uses process recycle. */
  onIdleRecycle?: () => Promise<void> | void;
}

export interface LazyEmbeddingFunctions {
  embedText: (text: string) => Promise<number[]>;
  embedTexts: (texts: string[]) => Promise<number[][]>;
  isLoaded: () => boolean;
  lifecycle: EmbeddingLifecycle;
  health: () => Omit<EmbedHealthSnapshot, "socket" | "uptime">;
  recycleNow: () => Promise<void>;
  stop: () => void;
}

export function createLazyEmbeddingFunctions({
  loadPipeline,
  log = (message: string) => console.log(message),
  idleRecycleMs = parseIdleRecycleMs(process.env.EMBED_IDLE_RECYCLE_MS),
  onIdleRecycle,
}: LazyEmbeddingOptions): LazyEmbeddingFunctions {
  let pipePromise: Promise<FeatureExtractionPipeline> | null = null;
  let loaded = false;
  let activeRequests = 0;
  let status: EmbedHealthState = "starting";
  let lastError: unknown = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let recyclePromise: Promise<void> | null = null;

  function clearIdleTimer(): void {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  function markReady(): void {
    if (status === "starting") status = "ready";
  }

  function markUnavailable(): void {
    status = "unavailable";
  }

  function health(): Omit<EmbedHealthSnapshot, "socket" | "uptime"> {
    const effectiveStatus = activeRequests > 0 && status === "ready" ? "busy" : status;
    return {
      status: effectiveStatus,
      model_loaded: loaded,
      active_requests: activeRequests,
      idle_recycle_ms: idleRecycleMs,
    };
  }

  async function unloadPipeline(): Promise<void> {
    const pipeline = pipePromise ? await pipePromise.catch(() => null) : null;
    pipePromise = null;
    loaded = false;
    lastError = null;
    if (!pipeline) return;

    const disposable = pipeline as FeatureExtractionPipeline & {
      dispose?: () => Promise<void> | void;
      _dispose?: () => Promise<void> | void;
    };
    const dispose = disposable.dispose ?? disposable._dispose;
    if (dispose) await dispose.call(pipeline);
  }

  async function recycleNow(): Promise<void> {
    if (recyclePromise) return recyclePromise;
    if (activeRequests > 0 || !loaded) return;
    clearIdleTimer();
    status = "recycling";
    recyclePromise = (async () => {
      try {
        await unloadPipeline();
        if (onIdleRecycle) await onIdleRecycle();
        status = "ready";
      } catch (error) {
        lastError = error;
        status = "unavailable";
        log(`embed model recycle failed: ${String(error)}`);
        throw error;
      } finally {
        recyclePromise = null;
      }
    })();
    return recyclePromise;
  }

  function scheduleIdleRecycle(): void {
    clearIdleTimer();
    if (idleRecycleMs <= 0 || !loaded || activeRequests > 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      void recycleNow().catch(() => {});
    }, idleRecycleMs);
    idleTimer.unref?.();
  }

  async function runRequest<T>(fn: () => Promise<T>): Promise<T> {
    if (recyclePromise) await recyclePromise;
    clearIdleTimer();
    activeRequests += 1;
    if (status === "ready" || status === "unavailable" || status === "starting") status = "busy";
    try {
      const result = await fn();
      lastError = null;
      status = "ready";
      return result;
    } catch (error) {
      lastError = error;
      status = "unavailable";
      throw error;
    } finally {
      activeRequests = Math.max(0, activeRequests - 1);
      if (activeRequests === 0 && status === "busy") status = lastError ? "unavailable" : "ready";
      scheduleIdleRecycle();
    }
  }

  async function getPipe(): Promise<FeatureExtractionPipeline> {
    if (!pipePromise) {
      log("Loading bge-m3 model on first embedding request...");
      pipePromise = loadPipeline()
        .then((pipe) => {
          loaded = true;
          log("bge-m3 model ready");
          return pipe;
        })
        .catch((error) => {
          pipePromise = null;
          throw error;
        });
    }
    return pipePromise;
  }

  async function embedText(text: string): Promise<number[]> {
    return runRequest(async () => {
      const pipe = await getPipe();
      const out = await pipe(text, { pooling: "mean", normalize: true });
      try {
        return Array.from(out.data) as number[];
      } finally {
        disposeEmbeddingOutput(out);
      }
    });
  }

  async function embedTexts(texts: string[]): Promise<number[][]> {
    return runRequest(async () => {
      const pipe = await getPipe();
      const out = await pipe(texts, { pooling: "mean", normalize: true });
      try {
        const dims = out.data.length / texts.length;
        const result: number[][] = [];
        for (let i = 0; i < texts.length; i++) {
          result.push(Array.from(out.data.slice(i * dims, (i + 1) * dims)) as number[]);
        }
        return result;
      } finally {
        disposeEmbeddingOutput(out);
      }
    });
  }

  function disposeEmbeddingOutput(output: unknown): void {
    const dispose = (output as { dispose?: unknown } | null)?.dispose;
    if (typeof dispose !== "function") return;
    try {
      dispose.call(output);
    } catch (error) {
      // Tensor disposal is diagnostic cleanup. Preserve the embedding result
      // or primary inference error while making the cleanup failure visible.
      log(`embed output dispose failed: ${String(error)}`);
    }
  }

  const lifecycle: EmbeddingLifecycle = { health, markReady, markUnavailable };
  return {
    embedText,
    embedTexts,
    isLoaded: () => loaded,
    lifecycle,
    health,
    recycleNow,
    stop: () => {
      clearIdleTimer();
      void unloadPipeline().catch(() => {});
    },
  };
}

export function parseIdleRecycleMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_EMBED_IDLE_RECYCLE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_EMBED_IDLE_RECYCLE_MS;
  return Math.min(MAX_EMBED_IDLE_RECYCLE_MS, Math.trunc(parsed));
}
