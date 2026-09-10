import { expect, test } from "bun:test";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLazyEmbeddingFunctions,
  createServer,
  DEFAULT_EMBED_MAX_REQUEST_BYTES,
  healthPortDiscoveryPath,
  parseHealthPort,
} from "../../packages/butler-agent/src/agent/cognition/memory/scripts/embed-server.ts";
import { bindLoadedEmbeddingAssetIdentity } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/embed-lifecycle.ts";
import {
  CheckedEmbeddingError,
  EmbedServerUnavailableError,
  embedCheckedViaSocket,
  embedViaSocket,
} from "../../packages/butler-agent/src/agent/cognition/memory/scripts/embed.ts";
import { bindObservedGenerationEmbeddingUnderWriteGate, initializeEmptyMemoryGeneration } from "../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts";
import { recallSourceBackedMemory } from "../../packages/butler-agent/src/agent/cognition/memory/recall/engine.ts";

test("checked v2 embedding uses the loaded tokenizer, rejects overflow before inference, and pins CLS metadata", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-embed-checked-"));
  const socketPath = join(tempDir, "embed.sock");
  let inferenceCalls = 0;
  let observedOptions: unknown;
  const tokenizer = Object.assign(
    (text: string) => ({ input_ids: { dims: [1, [...text].length + 2] } }),
    { model_max_length: 5 },
  );
  const pipeline = Object.assign(
    async (_input: string | string[], options?: { pooling?: string; normalize?: boolean }) => {
      inferenceCalls += 1;
      observedOptions = options;
      return { data: new Float32Array([0.25, 0.75]) };
    },
    { tokenizer, model: { config: { max_position_embeddings: 5 } } },
  ) as unknown as FeatureExtractionPipeline;
  bindLoadedEmbeddingAssetIdentity(pipeline, {
    tokenizer_asset_sha256: "a".repeat(64),
    model_asset_sha256: "b".repeat(64),
  });
  const embedding = createLazyEmbeddingFunctions({ loadPipeline: async () => pipeline, log: () => {} });
  const server = createServer(embedding.embedText, socketPath, embedding.embedTexts, { embedChecked: embedding.embedChecked });
  try {
    await server.ready;
    await expect(embedCheckedViaSocket({ texts: ["abcd"], socketPath })).rejects.toMatchObject({ code: "embed_input_too_long" });
    expect(inferenceCalls).toBe(0);
    const checked = await embedCheckedViaSocket({ texts: ["abc"], socketPath });
    expect(checked.metadata).toMatchObject({
      model: "Xenova/bge-m3",
      dimension: 2,
      pooling: "cls",
      normalize: true,
      max_tokens: 5,
      tokenizer_asset_sha256: "a".repeat(64),
      model_asset_sha256: "b".repeat(64),
    });
    expect(checked.metadata.version).toMatch(/^[0-9a-f]{64}$/u);
    expect(checked.token_counts).toEqual([5]);
    expect(inferenceCalls).toBe(1);
    expect(observedOptions).toEqual({ pooling: "cls", normalize: true });
    const limited = await embedCheckedViaSocket({ texts: ["abcdef"], socketPath, resplit: true, maxEmbeddings: 1 });
    expect(limited.embedded_texts).toEqual(["abc"]);
    expect(limited.omitted_count).toBe(1);
    expect(limited.token_counts).toEqual([5]);
    expect(limited.embeddings).toHaveLength(1);
    expect(inferenceCalls).toBe(2);
    let mismatch: unknown;
    try { await embedCheckedViaSocket({ texts: ["abc"], socketPath, expected: { ...checked.metadata, version: "b".repeat(64) } }); }
    catch (error) { mismatch = error; }
    expect(mismatch).toBeInstanceOf(CheckedEmbeddingError);
  } finally { server.stop(); embedding.stop(); rmSync(tempDir, { recursive: true, force: true }); }
});

async function rawEmbedRequest(socketPath: string, payload: unknown): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = "";
    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => { data += chunk.toString(); });
    socket.on("end", () => {
      try {
        resolve(JSON.parse(data.trim()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
  });
}

test("embedding model stays unloaded until the first request and is reused", async () => {
  let loads = 0;
  const logs: string[] = [];
  const pipeline = Object.assign(
    async (input: string | string[]) => ({
      data: new Float32Array(Array.isArray(input) ? input.length * 2 : 2).fill(0.5),
    }),
    {},
  ) as unknown as FeatureExtractionPipeline;
  const embedding = createLazyEmbeddingFunctions({
    loadPipeline: async () => {
      loads += 1;
      return pipeline;
    },
    log: (message) => logs.push(message),
  });

  expect(embedding.isLoaded()).toBe(false);
  expect(loads).toBe(0);

  expect(await embedding.embedText("hello")).toEqual([0.5, 0.5]);
  expect(await embedding.embedTexts(["one", "two"])).toEqual([
    [0.5, 0.5],
    [0.5, 0.5],
  ]);
  expect(embedding.isLoaded()).toBe(true);
  expect(loads).toBe(1);
  expect(logs).toEqual([
    "Loading bge-m3 model on first embedding request...",
    "bge-m3 model ready",
  ]);
});

test("embedding output tensors are disposed after copying caller-visible vectors", async () => {
  let disposed = 0;
  const pipeline = Object.assign(
    async (input: string | string[]) => ({
      data: new Float32Array(Array.isArray(input) ? input.length * 2 : 2).fill(0.5),
      dispose: () => { disposed += 1; },
    }),
    {},
  ) as unknown as FeatureExtractionPipeline;
  const embedding = createLazyEmbeddingFunctions({
    loadPipeline: async () => pipeline,
    log: () => {},
  });

  await expect(embedding.embedText("one")).resolves.toEqual([0.5, 0.5]);
  await expect(embedding.embedTexts(["one", "two"])).resolves.toEqual([
    [0.5, 0.5],
    [0.5, 0.5],
  ]);
  expect(disposed).toBe(2);
  embedding.stop();
});

test("a failed first load can be retried", async () => {
  let loads = 0;
  const pipeline = (async () => ({ data: new Float32Array([1]) })) as unknown as FeatureExtractionPipeline;
  const embedding = createLazyEmbeddingFunctions({
    loadPipeline: async () => {
      loads += 1;
      if (loads === 1) throw new Error("temporary load failure");
      return pipeline;
    },
    log: () => {},
  });
  await expect(embedding.embedText("first")).rejects.toThrow("temporary load failure");
  expect(embedding.isLoaded()).toBe(false);
  expect(await embedding.embedText("second")).toEqual([1]);
  expect(loads).toBe(2);
});

test("idle recycle waits for in-flight work and drops the loaded pipeline", async () => {
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  let recycles = 0;
  const pipeline = Object.assign(
    async () => {
      started();
      await releasePromise;
      return { data: new Float32Array([0.25]) };
    },
    {},
  ) as unknown as FeatureExtractionPipeline;
  const embedding = createLazyEmbeddingFunctions({
    idleRecycleMs: 10,
    loadPipeline: async () => pipeline,
    onIdleRecycle: () => { recycles += 1; },
    log: () => {},
  });
  embedding.lifecycle.markReady();

  const request = embedding.embedText("in-flight");
  await startedPromise;
  await Bun.sleep(30);
  expect(recycles).toBe(0);
  expect(embedding.health().status).toBe("busy");

  release();
  await request;
  await Bun.sleep(30);
  expect(recycles).toBe(1);
  expect(embedding.isLoaded()).toBe(false);
  expect(embedding.health().status).toBe("ready");
  embedding.stop();
});

test("health reports busy for an active first request while lifecycle is still starting", async () => {
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  const embedding = createLazyEmbeddingFunctions({
    idleRecycleMs: 0,
    loadPipeline: async () => Object.assign(
      async () => {
        started();
        await releasePromise;
        return { data: new Float32Array([0.5]) };
      },
      {},
    ) as unknown as FeatureExtractionPipeline,
    log: () => {},
  });
  const request = embedding.embedText("first");
  await startedPromise;
  expect(embedding.health()).toMatchObject({ status: "busy", active_requests: 1, model_loaded: true });
  release();
  await request;
  expect(embedding.health().status).toBe("ready");
  embedding.stop();
});

test("idle recycle recovers lazily on the next request", async () => {
  let loads = 0;
  let recycles = 0;
  const embedding = createLazyEmbeddingFunctions({
    idleRecycleMs: 5,
    loadPipeline: async () => {
      loads += 1;
      return Object.assign(
        async () => ({ data: new Float32Array([loads]) }),
        {},
      ) as unknown as FeatureExtractionPipeline;
    },
    onIdleRecycle: () => { recycles += 1; },
    log: () => {},
  });

  await expect(embedding.embedText("first")).resolves.toEqual([1]);
  await Bun.sleep(25);
  expect(recycles).toBe(1);
  await expect(embedding.embedText("second")).resolves.toEqual([2]);
  expect(loads).toBe(2);
  embedding.stop();
});

test("explicit recycle exposes the recycling state until cleanup settles", async () => {
  let recycleStarted!: () => void;
  let releaseRecycle!: () => void;
  const recycleStartedPromise = new Promise<void>((resolve) => { recycleStarted = resolve; });
  const releaseRecyclePromise = new Promise<void>((resolve) => { releaseRecycle = resolve; });
  const embedding = createLazyEmbeddingFunctions({
    idleRecycleMs: 0,
    loadPipeline: async () => Object.assign(
      async () => ({ data: new Float32Array([1]) }),
      {},
    ) as unknown as FeatureExtractionPipeline,
    onIdleRecycle: async () => {
      recycleStarted();
      await releaseRecyclePromise;
    },
    log: () => {},
  });
  embedding.lifecycle.markReady();

  await embedding.embedText("ready");
  const recycle = embedding.recycleNow();
  await recycleStartedPromise;
  expect(embedding.health().status).toBe("recycling");
  expect(embedding.isLoaded()).toBe(false);
  releaseRecycle();
  await recycle;
  expect(embedding.health().status).toBe("ready");
  embedding.stop();
});

test("Unix socket and HTTP health expose the same lifecycle state", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-embed-health-"));
  const socketPath = join(tempDir, "embed.sock");
  const embedding = createLazyEmbeddingFunctions({
    idleRecycleMs: 0,
    loadPipeline: async () => Object.assign(
      async () => ({ data: new Float32Array([1]) }),
      {},
    ) as unknown as FeatureExtractionPipeline,
    log: () => {},
  });
  const server = createServer(embedding.embedText, socketPath, undefined, {
    lifecycle: embedding.lifecycle,
    healthPort: 0,
  });
  try {
    await server.ready;
    const healthPort = server.healthPort();
    expect(healthPort).toBeGreaterThan(0);
    const httpHealth = await fetch(`http://127.0.0.1:${healthPort}/health`);
    const httpBody = await httpHealth.json() as { status: string; socket: string; model_loaded: boolean };
    expect(httpHealth.status).toBe(200);
    expect(httpBody).toMatchObject({ status: "ready", socket: socketPath, model_loaded: false });

    const socketHealth = await new Promise<{ health: { status: string; socket: string; model_loaded: boolean } }>((resolve, reject) => {
      const socket = createConnection(socketPath);
      let data = "";
      socket.on("connect", () => socket.write(JSON.stringify({ health: true }) + "\n"));
      socket.on("data", (chunk) => { data += chunk.toString(); });
      socket.on("end", () => {
        try {
          resolve(JSON.parse(data.trim()) as { health: { status: string; socket: string; model_loaded: boolean } });
        } catch (error) {
          reject(error);
        }
      });
      socket.on("error", reject);
    });
    expect(socketHealth.health).toMatchObject({
      status: httpBody.status,
      socket: httpBody.socket,
      model_loaded: httpBody.model_loaded,
    });
  } finally {
    server.stop();
    embedding.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("health port parser treats zero as an ephemeral configured endpoint", () => {
  expect(parseHealthPort("0")).toBe(0);
  expect(parseHealthPort("9847")).toBe(9847);
  expect(parseHealthPort("-1")).toBe(9847);
});

test("embed socket rejects oversized lines with a typed bounded error", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-embed-request-limit-"));
  const socketPath = join(tempDir, "embed.sock");
  const server = createServer(async () => [1], socketPath, undefined, {
    maxRequestBytes: 32,
  });
  try {
    await server.ready;
    const response = await rawEmbedRequest(socketPath, { text: "x".repeat(128) });
    expect(response).toMatchObject({ code: "embed_request_too_large" });
  } finally {
    server.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
  expect(DEFAULT_EMBED_MAX_REQUEST_BYTES).toBeGreaterThan(0);
});

test("embed queue rejects excess work and reports bounded queue health", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-embed-queue-limit-"));
  const socketPath = join(tempDir, "embed.sock");
  const healthEmbedding = createLazyEmbeddingFunctions({
    idleRecycleMs: 0,
    loadPipeline: async () => { throw new Error("not used"); },
    log: () => {},
  });
  let release!: () => void;
  const blocked = new Promise<number[]>((resolve) => { release = () => resolve([1]); });
  const server = createServer(() => blocked, socketPath, undefined, {
    lifecycle: healthEmbedding.lifecycle,
    healthPort: 0,
    maxQueueRequests: 1,
    maxQueueBytes: 1024,
  });
  let first: ReturnType<typeof createConnection> | null = null;
  try {
    await server.ready;
    first = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      first!.once("connect", () => {
        first!.write(`${JSON.stringify({ text: "first" })}\n`);
        resolve();
      });
      first!.once("error", reject);
    });
    const healthPort = server.healthPort();
    if (healthPort === null) throw new Error("health port unavailable");
    const health = await (await fetch(`http://127.0.0.1:${healthPort}/health`)).json() as Record<string, unknown>;
    expect(health).toMatchObject({ queued_requests: 1, max_queued_requests: 1 });
    const rejected = await rawEmbedRequest(socketPath, { text: "second" });
    expect(rejected).toMatchObject({ code: "embed_queue_full", retryable: true });
    release();
  } finally {
    first?.destroy();
    server.stop();
    healthEmbedding.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("checked socket queue enforces fairness, waiting cancellation, and deadlines", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-embed-scheduling-"));
  const socketPath = join(tempDir, "embed.sock");
  const starts: string[] = [];
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const metadata = { model: "test/bge-m3", dimension: 1, pooling: "cls" as const, normalize: true as const,
    version: "a".repeat(64), max_tokens: 8192, transformers_version: "test", node_runtime_version: process.version,
    bun_runtime_version: Bun.version, tokenizer_asset_sha256: "b".repeat(64), model_asset_sha256: "c".repeat(64) };
  const server = createServer(async () => [1], socketPath, undefined, { embedChecked: async (texts) => {
    starts.push(texts[0]!); if (texts[0] === "first") { firstStarted(); await firstBlocked; }
    return { embeddings: texts.map(() => [1]), token_counts: texts.map(() => 1), embedded_texts: texts, omitted_count: 0, metadata };
  } });
  const cleanup = new AbortController();
  try {
    await server.ready;
    const call = (name: string, requestClass: "interactive" | "background", options: { signal?: AbortSignal; deadlineAt?: number } = {}) => embedCheckedViaSocket({
      texts: [name], socketPath, requestClass, timeoutMs: 2_000, signal: options.signal ?? cleanup.signal, deadlineAt: options.deadlineAt,
    });
    const first = call("first", "interactive"); await firstStartedPromise;
    const background = call("background", "background");
    const interactive = Array.from({ length: 9 }, (_, index) => call(`interactive-${index + 1}`, "interactive"));
    const cancelledController = new AbortController();
    const cancelled = call("cancelled", "background", { signal: cancelledController.signal }).then(() => null, (error) => error as { code?: string });
    const expired = call("expired", "background", { deadlineAt: Date.now() + 100 }).then(() => null, (error) => error as { code?: string });
    await Bun.sleep(110); cancelledController.abort(); await Bun.sleep(20); releaseFirst();
    const values = await Promise.all([first, background, ...interactive, cancelled, expired]);
    expect(starts[0]).toBe("first");
    expect(starts.indexOf("background")).toBeGreaterThan(0); expect(starts.indexOf("background")).toBeLessThanOrEqual(8);
    expect(starts.filter((value) => value.startsWith("interactive-"))).toHaveLength(9);
    expect(starts).not.toContain("cancelled"); expect(starts).not.toContain("expired");
    expect(values.at(-2)).toMatchObject({ code: "embed_request_cancelled" }); expect(values.at(-1)).toMatchObject({ code: "embed_request_deadline" });
  } finally { releaseFirst(); cleanup.abort(); server.stop(); rmSync(tempDir, { recursive: true, force: true }); }
});

test("native v2 recall forwards caller cancellation to the checked vector socket", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-recall-cancel-"));
  const socketPath = process.env.EMBED_SOCKET!;
  const metadata = { model: "test/bge-m3", dimension: 1, pooling: "cls" as const, normalize: true as const,
    version: "a".repeat(64), max_tokens: 8192, transformers_version: "test", node_runtime_version: process.version,
    bun_runtime_version: Bun.version, tokenizer_asset_sha256: "b".repeat(64), model_asset_sha256: "c".repeat(64) };
  const descriptor = initializeEmptyMemoryGeneration(butlerData);
  const controller = new AbortController();
  const server = createServer(async () => [1], socketPath, undefined, { embedChecked: async (texts) => {
    await Bun.sleep(50);
    return { embeddings: texts.map(() => [1]), token_counts: texts.map(() => 1), embedded_texts: texts, omitted_count: 0, metadata };
  } });
  try {
    bindObservedGenerationEmbeddingUnderWriteGate({ butlerData,
      target: { kind: "active", expected_generation: descriptor.generation_id }, signal: controller.signal }, metadata);
    await server.ready;
    const pending = recallSourceBackedMemory({
      context: { butlerData, target: { kind: "active", expected_generation: descriptor.generation_id }, signal: controller.signal },
      cue: "cancel this recall", includeVector: true, includeInternal: false, limit: 6,
      scope: "all_user_sessions", projectFilter: "unassigned", projectIds: [], sessionIds: [],
      asOf: new Date().toISOString(),
      runtime: { sessionId: "session", turnId: "turn", currentUserMessage: "cancel this recall", nativeOperationId: "operation", projectId: null },
    });
    await Bun.sleep(10);
    controller.abort();
    const result = await pending;
    expect(result.coverage.vectors).toMatchObject({ state: "unavailable", codes: ["embed_request_cancelled"] });
  } finally { server.stop(); rmSync(butlerData, { recursive: true, force: true }); }
});

test("configured health bind failure rejects server readiness instead of silently disappearing", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-embed-health-bind-"));
  const firstSocketPath = join(tempDir, "first.sock");
  const secondSocketPath = join(tempDir, "second.sock");
  const first = createServer(async () => [1], firstSocketPath, undefined, { healthPort: 0 });
  let second: ReturnType<typeof createServer> | null = null;
  try {
    await first.ready;
    const occupiedPort = first.healthPort();
    expect(occupiedPort).toBeGreaterThan(0);
    const secondEmbedding = createLazyEmbeddingFunctions({ loadPipeline: async () => {
      throw new Error("not used");
    }, log: () => {} });
    second = createServer(async () => [1], secondSocketPath, undefined, {
      healthPort: occupiedPort!,
      healthPortProbeLimit: 0,
      lifecycle: secondEmbedding.lifecycle,
    });
    await expect(second.ready).rejects.toBeDefined();
    expect(secondEmbedding.health().status).toBe("unavailable");
    secondEmbedding.stop();
  } finally {
    second?.stop();
    first.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("occupied configured health port probes a bounded fallback and publishes discovery", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-embed-health-probe-"));
  const firstSocketPath = join(tempDir, "first.sock");
  const secondSocketPath = join(tempDir, "second.sock");
  const first = createServer(async () => [1], firstSocketPath, undefined, { healthPort: 0 });
  let second: ReturnType<typeof createServer> | null = null;
  try {
    await first.ready;
    const occupiedPort = first.healthPort();
    expect(occupiedPort).toBeGreaterThan(0);
    second = createServer(async () => [1], secondSocketPath, undefined, { healthPort: occupiedPort! });
    await second.ready;
    const fallbackPort = second.healthPort();
    expect(fallbackPort).toBeGreaterThan(0);
    if (fallbackPort === null) throw new Error("fallback health port was not bound");
    expect(fallbackPort).not.toBe(occupiedPort);
    expect(Number(readFileSync(healthPortDiscoveryPath(secondSocketPath), "utf8").trim())).toBe(fallbackPort);
    const response = await fetch(`http://127.0.0.1:${fallbackPort}/health`);
    expect(response.status).toBe(200);
    expect((await response.json()) as { status: string }).toMatchObject({ status: "ready" });
  } finally {
    second?.stop();
    first.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("embed caller preserves null fallback and bounded timeout during server recycle", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-embed-caller-"));
  const missingSocket = join(tempDir, "missing.sock");
  const hangingSocket = join(tempDir, "hanging.sock");
  const hangingServer = createServer(() => new Promise<number[]>(() => {}), hangingSocket);
  try {
    await expect(embedViaSocket("fallback", missingSocket, 50)).resolves.toBeNull();
    await hangingServer.ready;
    await expect(embedViaSocket("timeout", hangingSocket, 20)).rejects.toBeInstanceOf(
      EmbedServerUnavailableError,
    );
  } finally {
    hangingServer.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("embedding server restricts its Unix socket to the current user", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-embed-server-mode-"));
  const socketPath = join(tempDir, "embed.sock");
  const server = createServer(async () => [1], socketPath);
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (existsSync(socketPath) && (statSync(socketPath).mode & 0o777) === 0o600) break;
      await Bun.sleep(10);
    }
    expect(existsSync(socketPath)).toBe(true);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  } finally {
    server.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
