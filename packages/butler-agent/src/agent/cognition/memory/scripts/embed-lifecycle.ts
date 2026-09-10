import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

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
  modelId?: string;
}

export interface EmbeddingRuntimeMetadata {
  model: string;
  dimension: number;
  pooling: "cls";
  normalize: true;
  version: string;
  max_tokens: number;
  transformers_version: string;
  node_runtime_version: string;
  bun_runtime_version: string | null;
  tokenizer_asset_sha256: string;
  model_asset_sha256: string;
}

export type CheckedEmbeddingResult = {
  embeddings: number[][];
  token_counts: number[];
  embedded_texts?: string[];
  omitted_count?: number;
  metadata: EmbeddingRuntimeMetadata;
};

export class EmbeddingInputTooLongError extends Error {
  readonly code = "embed_input_too_long";
  constructor(readonly tokenCount: number, readonly maxTokens: number) {
    super(`Embedding input has ${tokenCount} tokens; maximum is ${maxTokens}`);
  }
}

const EMBEDDING_ASSET_IDENTITY = Symbol.for("butler.embedding.asset-identity");

export type LoadedEmbeddingAssetIdentity = {
  tokenizer_asset_sha256: string;
  model_asset_sha256: string;
};

export function bindLoadedEmbeddingAssetIdentity(pipe: FeatureExtractionPipeline, identity: LoadedEmbeddingAssetIdentity): void {
  if (!validSha256(identity.tokenizer_asset_sha256) || !validSha256(identity.model_asset_sha256)) throw new Error("embed_asset_identity_invalid");
  Object.defineProperty(pipe, EMBEDDING_ASSET_IDENTITY, { value: identity, enumerable: false, configurable: false });
}

export interface LazyEmbeddingFunctions {
  embedText: (text: string) => Promise<number[]>;
  embedTexts: (texts: string[]) => Promise<number[][]>;
  embedChecked: (texts: string[], options?: { resplit?: boolean; maxEmbeddings?: number }) => Promise<CheckedEmbeddingResult>;
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
  modelId = "Xenova/bge-m3",
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

  async function embedChecked(texts: string[], options: { resplit?: boolean; maxEmbeddings?: number } = {}): Promise<CheckedEmbeddingResult> {
    if (texts.length === 0) throw new Error("embed_invalid_request");
    return runRequest(async () => {
      const pipe = await getPipe();
      const maxTokens = embeddingMaxTokens(pipe);
      const prepared = options.resplit ? resplitForTokenizer(pipe, texts, maxTokens) : texts;
      const maxEmbeddings = options.maxEmbeddings === undefined ? prepared.length : Math.max(1, Math.trunc(options.maxEmbeddings));
      const embeddedTexts = prepared.slice(0, maxEmbeddings);
      const tokenCounts = embeddedTexts.map((text) => embeddingTokenCount(pipe, text));
      const overflow = tokenCounts.find((count) => count > maxTokens);
      if (overflow !== undefined) throw new EmbeddingInputTooLongError(overflow, maxTokens);
      const out = await pipe(embeddedTexts, { pooling: "cls", normalize: true });
      try {
        const dimension = out.data.length / embeddedTexts.length;
        if (!Number.isSafeInteger(dimension) || dimension <= 0)
          throw new Error("embed_dimension_invalid");
        const embeddings: number[][] = [];
        for (let i = 0; i < embeddedTexts.length; i += 1)
          embeddings.push(Array.from(out.data.slice(i * dimension, (i + 1) * dimension)) as number[]);
        const runtimeVersion = installedTransformersVersion();
        const assets = loadedAssetIdentity(pipe);
        const identity = embeddingIdentity({ modelId, runtimeVersion, dimension, maxTokens, assets });
        return {
          embeddings,
          token_counts: tokenCounts,
          ...(options.resplit ? { embedded_texts: embeddedTexts, omitted_count: Math.max(0, prepared.length - embeddedTexts.length) } : {}),
          metadata: {
            model: modelId,
            dimension,
            pooling: "cls",
            normalize: true,
            version: identity,
            max_tokens: maxTokens,
            transformers_version: runtimeVersion,
            node_runtime_version: process.versions.node,
            bun_runtime_version: process.versions.bun ?? null,
            ...assets,
          },
        };
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
    embedChecked,
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

function resplitForTokenizer(pipe: FeatureExtractionPipeline, texts: string[], maxTokens: number): string[] {
  const output: string[] = [];
  const visit = (text: string): void => {
    if (embeddingTokenCount(pipe, text) <= maxTokens) { output.push(text); return; }
    const graphemes = [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text)].map((part) => part.segment);
    if (graphemes.length <= 1) throw new Error("embed_grapheme_too_long");
    const middle = Math.ceil(graphemes.length / 2);
    visit(graphemes.slice(0, middle).join(""));
    visit(graphemes.slice(middle).join(""));
  };
  for (const text of texts) visit(text);
  return output;
}

function embeddingMaxTokens(pipe: FeatureExtractionPipeline): number {
  const tokenizerMax = Number(pipe.tokenizer.model_max_length);
  const modelMax = Number((pipe.model.config as { max_position_embeddings?: unknown }).max_position_embeddings);
  const values = [tokenizerMax, modelMax].filter((value) => Number.isSafeInteger(value) && value > 0);
  if (values.length === 0) throw new Error("embed_tokenizer_limit_unavailable");
  return Math.min(...values);
}

function embeddingTokenCount(pipe: FeatureExtractionPipeline, text: string): number {
  const encoded = pipe.tokenizer(text, { padding: false, truncation: false }) as { input_ids?: { dims?: number[]; data?: ArrayLike<number> } };
  const ids = encoded.input_ids;
  const count = ids?.dims?.at(-1) ?? ids?.data?.length;
  if (!Number.isSafeInteger(count) || (count ?? 0) <= 0) throw new Error("embed_token_count_unavailable");
  return count!;
}

function loadedAssetIdentity(pipe: FeatureExtractionPipeline): LoadedEmbeddingAssetIdentity {
  const assetIdentity = (pipe as unknown as Record<symbol, unknown>)[EMBEDDING_ASSET_IDENTITY] as LoadedEmbeddingAssetIdentity | undefined;
  if (!assetIdentity || !validSha256(assetIdentity.tokenizer_asset_sha256) || !validSha256(assetIdentity.model_asset_sha256)) throw new Error("embed_asset_identity_unavailable");
  return assetIdentity;
}

function embeddingIdentity(input: { modelId: string; runtimeVersion: string; dimension: number; maxTokens: number; assets: LoadedEmbeddingAssetIdentity }): string {
  const identity = [
    "butler-embedding-runtime-v1",
    input.modelId,
    input.runtimeVersion,
    "cls",
    true,
    input.dimension,
    input.maxTokens,
    input.assets.tokenizer_asset_sha256,
    input.assets.model_asset_sha256,
    process.versions.node ?? null,
    process.versions.bun ?? null,
  ];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function validSha256(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value); }

let transformersVersion: string | null = null;
function installedTransformersVersion(): string {
  if (transformersVersion) return transformersVersion;
  const require = createRequire(import.meta.url);
  let current = dirname(require.resolve("@huggingface/transformers"));
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const parsed = JSON.parse(readFileSync(join(current, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
      if (parsed.name === "@huggingface/transformers" && typeof parsed.version === "string" && parsed.version)
        return transformersVersion = parsed.version;
    } catch {}
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("embed_runtime_version_unavailable");
}

export function parseIdleRecycleMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_EMBED_IDLE_RECYCLE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_EMBED_IDLE_RECYCLE_MS;
  return Math.min(MAX_EMBED_IDLE_RECYCLE_MS, Math.trunc(parsed));
}
