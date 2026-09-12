import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchGenerationVectors, type GenerationVectorRow } from "../../packages/butler-agent/src/agent/cognition/memory/recall/vector.ts";
import type { MemoryGenerationHandle } from "../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts";

test("node-only generation search preserves default node results and omits episodes", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-vector-search-scope-"));
  const socketPath = join(root, "embed.sock");
  const version = "a".repeat(64);
  const generation: MemoryGenerationHandle = {
    generationId: "generation", root, graphPath: join(root, "graph.sqlite"), sourceRoot: root, canonicalSnapshotPath: null,
    embedding: { model: "test/model", dimension: 2, pooling: "cls", normalize: true, version, max_tokens: 8192,
      transformers_version: "test", node_runtime_version: process.version, bun_runtime_version: Bun.version,
      tokenizer_asset_sha256: "b".repeat(64), model_asset_sha256: "c".repeat(64) },
  };
  const row = (kind: "node" | "episode", vector: number[]): GenerationVectorRow => ({
    vector_key: `${kind}-key`, generation: generation.generationId, record_kind: kind, owner_id: `${kind}-owner`,
    owner_revision: "revision", source_revision: "revision", embedding_chunk_id: `${kind}-chunk`, embedding_version: version,
    project_id: "", origin_kind: "user_input", source_kind: "conversation", conversation_session_id: "session",
    source_observed_at: "2026-09-13T00:00:00.000Z", source_refs_json: JSON.stringify([`${kind}-source`]), text: "", vector,
  });
  mkdirSync(join(root, "butler.lance"), { recursive: true });
  const lancedb = await import("@lancedb/lancedb");
  const connection = await lancedb.connect(join(root, "butler.lance"));
  await connection.createTable("butler_memory", [row("node", [1, 0]), row("episode", [0.5, 0.5])]);
  const server = createServer((socket) => {
    let payload = "";
    socket.on("data", (chunk) => {
      payload += chunk.toString();
      if (!payload.includes("\n")) return;
      const request = JSON.parse(payload.trim()) as { texts: string[] };
      socket.end(`${JSON.stringify({ embeddings: request.texts.map(() => [1, 0]), token_counts: request.texts.map(() => 1),
        embedded_texts: request.texts, omitted_count: 0, metadata: generation.embedding })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  try {
    const base = { generation, phrases: ["cue"], scope: "all_user_sessions" as const, projectFilter: "any" as const,
      projectIds: [], runtimeProjectId: null, runtimeSessionId: "session", sessionIds: [], asOf: "2026-09-13T01:00:00.000Z",
      includeInternal: false, socketPath, deadlineAt: Date.now() + 5_000 };
    const full = await searchGenerationVectors(base);
    const nodesOnly = await searchGenerationVectors({ ...base, includeEpisodes: false });
    expect(full.nodes).toEqual(nodesOnly.nodes);
    expect(full.episodes).toHaveLength(1);
    expect(nodesOnly.episodes).toEqual([]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
