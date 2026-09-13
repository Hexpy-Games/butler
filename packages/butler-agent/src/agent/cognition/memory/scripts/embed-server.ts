import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import { join } from "node:path";
import { butlerDataPath } from "../../../../runtime/paths.ts";
import { createServer as netCreateServer } from "net";
import { chmodSync, existsSync, unlinkSync } from "fs";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import {
  createLazyEmbeddingFunctions as createLazyEmbeddingFunctionsImpl,
  bindLoadedEmbeddingAssetIdentity,
  type EmbeddingLifecycle,
  type LazyEmbeddingFunctions,
  type LazyEmbeddingOptions,
  type CheckedEmbeddingResult,
  type LoadedEmbeddingAssetIdentity,
} from "./embed-lifecycle.ts";
import {
  createHealthServer,
  healthSnapshot,
  type EmbedHealthServerHandle,
} from "./embed-health.ts";
import { createEmbedRequestQueue } from "./embed-request-queue.ts";
import { recordOperationalMetric } from "../../../../operations/metrics/operational-metrics.ts";

export {
  DEFAULT_EMBED_IDLE_RECYCLE_MS,
  MAX_EMBED_IDLE_RECYCLE_MS,
  parseIdleRecycleMs,
} from "./embed-lifecycle.ts";
export type {
  EmbedHealthSnapshot,
  EmbedHealthState,
  EmbeddingLifecycle,
  LazyEmbeddingFunctions,
  LazyEmbeddingOptions,
} from "./embed-lifecycle.ts";
export { createHealthServer, healthPortDiscoveryPath, healthSnapshot } from "./embed-health.ts";
export type { EmbedHealthServerHandle } from "./embed-health.ts";

const DEFAULT_SOCKET = process.env.EMBED_SOCKET ?? "/tmp/butler-embed.sock";
export const DEFAULT_EMBED_MAX_REQUEST_BYTES = 1 * 1024 * 1024;
export {
  DEFAULT_EMBED_MAX_QUEUE_REQUESTS,
  DEFAULT_EMBED_MAX_QUEUE_BYTES,
} from "./embed-request-queue.ts";

export interface EmbedServerOptions {
  healthPort?: number;
  lifecycle?: EmbeddingLifecycle;
  healthPortProbeLimit?: number;
  maxRequestBytes?: number;
  maxQueueRequests?: number;
  maxQueueBytes?: number;
  embedChecked?: (texts: string[], options?: { resplit?: boolean; maxEmbeddings?: number }) => Promise<CheckedEmbeddingResult>;
}

export interface EmbedServerHandle {
  stop(): void;
  ready: Promise<void>;
  healthPort: () => number | null;
}

async function loadDefaultPipeline(): Promise<FeatureExtractionPipeline> {
  const { pipeline } = await import("@huggingface/transformers");
  const createPipeline = pipeline as unknown as (
    task: "feature-extraction",
    model: string,
    options: { dtype: "q8"; cache_dir: string },
  ) => Promise<FeatureExtractionPipeline>;
  const cacheDir = join(butlerDataPath(), "cache", "models");
  const loaded = await createPipeline("feature-extraction", "Xenova/bge-m3", {
    dtype: "q8",
    cache_dir: cacheDir,
  });
  bindLoadedEmbeddingAssetIdentity(loaded, await fingerprintLoadedBgeAssets(cacheDir));
  return loaded;
}

async function fingerprintLoadedBgeAssets(cacheDir: string): Promise<LoadedEmbeddingAssetIdentity> {
  const root = join(cacheDir, "Xenova", "bge-m3");
  return {
    tokenizer_asset_sha256: await aggregateAssetHash(root, ["tokenizer.json", "tokenizer_config.json"]),
    model_asset_sha256: await aggregateAssetHash(root, ["config.json", join("onnx", "model_quantized.onnx")]),
  };
}

async function aggregateAssetHash(root: string, files: string[]): Promise<string> {
  const aggregate = createHash("sha256");
  for (const relative of files) aggregate.update(JSON.stringify([relative, await hashFile(join(root, relative))]));
  return aggregate.digest("hex");
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", () => reject(new Error("embed_asset_identity_unavailable")));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export function createLazyEmbeddingFunctions(
  options: Omit<LazyEmbeddingOptions, "loadPipeline"> & {
    loadPipeline?: LazyEmbeddingOptions["loadPipeline"];
  } = {},
): LazyEmbeddingFunctions {
  return createLazyEmbeddingFunctionsImpl({
    loadPipeline: options.loadPipeline ?? loadDefaultPipeline,
    ...options,
  });
}

const processCleanupHandlers = new Set<() => void>();
let processCleanupHooksInstalled = false;

function runProcessCleanup(): void {
  for (const cleanup of [...processCleanupHandlers]) cleanup();
}

function registerProcessCleanup(cleanup: () => void): () => void {
  processCleanupHandlers.add(cleanup);
  if (!processCleanupHooksInstalled) {
    processCleanupHooksInstalled = true;
    process.once("exit", runProcessCleanup);
    process.once("SIGINT", () => { runProcessCleanup(); process.exit(0); });
    process.once("SIGTERM", () => { runProcessCleanup(); process.exit(0); });
  }
  return () => processCleanupHandlers.delete(cleanup);
}

export function createServer(
  embedFn: (text: string) => Promise<number[]>,
  socketPath = DEFAULT_SOCKET,
  embedBatchFn?: (texts: string[]) => Promise<number[][]>,
  options: EmbedServerOptions = {},
): EmbedServerHandle {
  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }

  // Serialize all model inference through the bounded queue module to prevent
  // concurrent forward passes and unbounded retention from slow clients.
  const maxRequestBytes = boundedPositiveOption(
    options.maxRequestBytes,
    DEFAULT_EMBED_MAX_REQUEST_BYTES,
  );
  const requestQueue = createEmbedRequestQueue({
    ...options,
    onEvent: (event) => recordOperationalMetric({
      category: "memory",
      name: `embedding_queue_${event.phase}`,
      status: event.code ? "error" : "ok",
      durationMs: event.phase === "settled" ? event.runMs ?? 0 : event.waitMs,
      dimensions: {
        request_class: event.requestClass,
        active: String(event.active),
        code: event.code ?? "none",
      },
    }),
  });

  let healthServer: EmbedHealthServerHandle | null = null;
  let boundHealthPort: number | null = null;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const server = netCreateServer((socket) => {
    let buffer = Buffer.alloc(0);
    let closed = false;
    let admitted = false;
    const requestAbort = new AbortController();
    const respond = (value: unknown): void => {
      if (closed || socket.destroyed) return;
      closed = true;
      socket.write(`${JSON.stringify(value)}\n`);
      socket.end();
    };
    const respondError = (error: unknown, fallbackCode = "embed_request_failed"): void => {
      const code = typeof (error as { code?: unknown })?.code === "string"
        ? (error as { code: string }).code
        : fallbackCode;
      respond({
        error: error instanceof Error ? error.message : String(error),
        code,
        ...(["embed_queue_full", "embed_request_deadline", "embed_request_cancelled"].includes(code)
          ? { retryable: true } : {}),
        ...(code === "embed_input_too_long"
          ? {
              token_count: (error as { tokenCount?: number }).tokenCount,
              max_tokens: (error as { maxTokens?: number }).maxTokens,
            }
          : {}),
      });
    };
    const handleLine = (line: Buffer): void => {
      if (admitted) {
        respondError(new Error("Only one embedding request is allowed per socket"), "embed_invalid_request");
        return;
      }
      admitted = true;
      const requestBytes = line.byteLength + 1;
      if (line.byteLength > maxRequestBytes) {
        respondError(new Error(`Embedding request exceeds ${maxRequestBytes} bytes`), "embed_request_too_large");
        return;
      }
      let req: { text?: string; texts?: string[]; health?: boolean; checked?: boolean; resplit?: boolean; max_embeddings?: number; request_class?: "interactive" | "background"; deadline_at?: number };
      try {
        req = JSON.parse(line.toString("utf8"));
      } catch {
        respondError(new Error("Invalid JSON"), "embed_invalid_json");
        return;
      }

      if (req.health === true) {
        respond({ health: healthSnapshot(socketPath, options.lifecycle, requestQueue.snapshot()) });
        return;
      }

      const requestClass = req.request_class ?? "interactive";
      const deadlineAt = req.deadline_at ?? Number.POSITIVE_INFINITY;
      if (!(["interactive", "background"] as const).includes(requestClass) ||
        (!Number.isFinite(deadlineAt) && deadlineAt !== Number.POSITIVE_INFINITY)) {
        respondError(new Error("Invalid embedding scheduling metadata"), "embed_invalid_request");
        return;
      }
      const scheduling = { requestClass, deadlineAt, signal: requestAbort.signal };

      if (req.checked === true) {
        const texts = Array.isArray(req.texts) ? req.texts : typeof req.text === "string" ? [req.text] : [];
        if (!options.embedChecked || texts.length === 0 || !texts.every((text) => typeof text === "string" && text.length > 0)) {
          respondError(new Error("Invalid checked embedding request"), "embed_invalid_request");
          return;
        }
        if (req.max_embeddings !== undefined && (!Number.isSafeInteger(req.max_embeddings) || req.max_embeddings < 1 || req.max_embeddings > 32)) {
          respondError(new Error("Invalid checked embedding limit"), "embed_invalid_request");
          return;
        }
        if (requestClass === "background" && texts.length > 4) {
          respondError(new Error("Background embedding batch exceeds 4 chunks"), "embed_invalid_request");
          return;
        }
        requestQueue.enqueue(() => options.embedChecked!(texts, { resplit: req.resplit === true, maxEmbeddings: req.max_embeddings }), requestBytes, scheduling)
          .then((result) => respond(result))
          .catch((error) => respondError(error));
        return;
      }

      if (Array.isArray(req.texts)) {
        const texts = req.texts;
        if (texts.length === 0 || !texts.every((t) => typeof t === "string")) {
          respondError(new Error("Invalid 'texts' field"), "embed_invalid_request");
          return;
        }
        if (requestClass === "background" && texts.length > 4) {
          respondError(new Error("Background embedding batch exceeds 4 chunks"), "embed_invalid_request");
          return;
        }
        const batchFn = embedBatchFn ?? ((ts: string[]) => Promise.all(ts.map(embedFn)));
        requestQueue.enqueue(() => batchFn(texts), requestBytes, scheduling)
          .then((embeddings) => respond({ embeddings }))
          .catch((err) => respondError(err));
        return;
      }

      if (typeof req.text !== "string" || !req.text) {
        respondError(new Error("Missing 'text' or 'texts' field"), "embed_invalid_request");
        return;
      }

      requestQueue.enqueue(() => embedFn(req.text!), requestBytes, scheduling)
        .then((embedding) => respond({ embedding }))
        .catch((err) => respondError(err));
    };
    socket.on("data", (chunk) => {
      if (closed) return;
      buffer = Buffer.concat([buffer, chunk]);
      let newlineIdx = buffer.indexOf(0x0a);
      while (newlineIdx >= 0) {
        const line = buffer.subarray(0, newlineIdx);
        buffer = buffer.subarray(newlineIdx + 1);
        handleLine(line);
        if (closed) return;
        newlineIdx = buffer.indexOf(0x0a);
      }
      if (buffer.byteLength > maxRequestBytes) {
        respondError(new Error(`Embedding request exceeds ${maxRequestBytes} bytes`), "embed_request_too_large");
      }
    });

    socket.on("error", () => {});
    socket.on("close", () => requestAbort.abort());
  });
  server.once("error", (error) => {
    options.lifecycle?.markUnavailable?.();
    rejectReady(error instanceof Error ? error : new Error(String(error)));
  });

  server.on("listening", () => {
    if (process.platform !== "win32") chmodSync(socketPath, 0o600);
    if (options.healthPort !== undefined) {
      healthServer = createHealthServer({
        healthPort: options.healthPort,
        socketPath,
        lifecycle: options.lifecycle,
        queue: requestQueue.snapshot,
        portProbeLimit: options.healthPortProbeLimit,
      });
      healthServer.ready.then(() => {
        boundHealthPort = healthServer?.port() ?? null;
        options.lifecycle?.markReady();
        resolveReady();
      }).catch((error) => {
        options.lifecycle?.markUnavailable?.();
        rejectReady(error instanceof Error ? error : new Error(String(error)));
      });
    } else {
      options.lifecycle?.markReady();
      resolveReady();
    }
  });
  server.listen(socketPath);

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    healthServer?.stop();
    try {
      if (existsSync(socketPath)) unlinkSync(socketPath);
    } catch {}
  };
  const unregisterProcessCleanup = registerProcessCleanup(cleanup);

  return {
    stop() {
      unregisterProcessCleanup();
      healthServer?.stop();
      server.close();
      cleanup();
    },
    ready,
    healthPort: () => boundHealthPort,
  };
}

if (import.meta.main) {
  const embedding = createLazyEmbeddingFunctions({
    onIdleRecycle: () => {
      console.log("embed-server idle boundary reached; recycling supervised process");
      process.exit(0);
    },
  });
  const healthPort = parseHealthPort(process.env.EMBED_HEALTH_PORT);
  const server = createServer(embedding.embedText, DEFAULT_SOCKET, embedding.embedTexts, {
    healthPort,
    lifecycle: embedding.lifecycle,
    embedChecked: embedding.embedChecked,
  });
  console.log(`embed-server ready on socket ${DEFAULT_SOCKET}; model loads on first request`);
  server.ready.catch((error) => {
    console.error(`embed-server health check failed: ${String(error)}`);
    server.stop();
    process.exit(1);
  });
}

export function parseHealthPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 9847;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) return 9847;
  return parsed;
}

function boundedPositiveOption(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}
