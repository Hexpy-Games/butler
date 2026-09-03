import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import { join } from "node:path";
import { butlerDataPath } from "../../../../runtime/paths.ts";
import { createServer as netCreateServer } from "net";
import { chmodSync, existsSync, unlinkSync } from "fs";
import {
  createLazyEmbeddingFunctions as createLazyEmbeddingFunctionsImpl,
  type EmbeddingLifecycle,
  type LazyEmbeddingFunctions,
  type LazyEmbeddingOptions,
} from "./embed-lifecycle.ts";
import {
  createHealthServer,
  healthSnapshot,
  type EmbedHealthServerHandle,
} from "./embed-health.ts";
import { createEmbedRequestQueue } from "./embed-request-queue.ts";

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
  return createPipeline("feature-extraction", "Xenova/bge-m3", {
    dtype: "q8",
    cache_dir: join(butlerDataPath(), "cache", "models"),
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
  const requestQueue = createEmbedRequestQueue(options);

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
        ...(code === "embed_queue_full" ? { retryable: true } : {}),
      });
    };
    const handleLine = (line: Buffer): void => {
      const requestBytes = line.byteLength + 1;
      if (line.byteLength > maxRequestBytes) {
        respondError(new Error(`Embedding request exceeds ${maxRequestBytes} bytes`), "embed_request_too_large");
        return;
      }
      let req: { text?: string; texts?: string[]; health?: boolean };
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

      if (Array.isArray(req.texts)) {
        const texts = req.texts;
        if (texts.length === 0 || !texts.every((t) => typeof t === "string")) {
          respondError(new Error("Invalid 'texts' field"), "embed_invalid_request");
          return;
        }
        const batchFn = embedBatchFn ?? ((ts: string[]) => Promise.all(ts.map(embedFn)));
        requestQueue.enqueue(() => batchFn(texts), requestBytes)
          .then((embeddings) => respond({ embeddings }))
          .catch((err) => respondError(err));
        return;
      }

      if (typeof req.text !== "string" || !req.text) {
        respondError(new Error("Missing 'text' or 'texts' field"), "embed_invalid_request");
        return;
      }

      requestQueue.enqueue(() => embedFn(req.text!), requestBytes)
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
