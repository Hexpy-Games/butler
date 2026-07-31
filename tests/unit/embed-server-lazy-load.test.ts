import { expect, test } from "bun:test";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLazyEmbeddingFunctions,
  createServer,
} from "../../packages/butler-agent/src/agent/cognition/memory/scripts/embed-server.ts";

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
