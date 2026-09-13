import { afterAll, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const vectorModule = await import("../../packages/butler-agent/src/agent/cognition/memory/recall/vector.ts");
mock.module("../../packages/butler-agent/src/agent/cognition/memory/recall/vector.ts", () => ({
  ...vectorModule,
  searchGenerationVectors: async (input: { deadlineAt: number }) => {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, input.deadlineAt - Date.now())));
    throw new Error("vector_deadline");
  },
}));

afterAll(() => {
  mock.module("../../packages/butler-agent/src/agent/cognition/memory/recall/vector.ts", () => vectorModule);
});

test("exhausted optional vector search still returns canonical source evidence", async () => {
  const { initializeEmptyMemoryGeneration } = await import("../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts");
  const { AgentConversationStore } = await import("../../packages/butler-agent/src/agent/conversation/store.ts");
  const { ingestConversationMemory } = await import("../../packages/butler-agent/src/agent/cognition/memory/projection/ingestion.ts");
  const { recallSourceBackedMemory } = await import("../../packages/butler-agent/src/agent/cognition/memory/recall/engine.ts");
  const root = mkdtempSync(join(tmpdir(), "memory-vector-budget-"));
  const store = new AgentConversationStore({ butlerData: root });
  try {
    const descriptor = initializeEmptyMemoryGeneration(root);
    const context = { butlerData: root, target: { kind: "active" as const, expected_generation: descriptor.generation_id }, signal: new AbortController().signal };
    store.beginTurn({ gateway: "app", externalSessionId: "session", sessionId: "session", actor: "user", turnId: "turn" });
    const user = store.appendUserMessage({ sessionId: "session", turnId: "turn", text: "The cobalt telescope uses a ceramic mount.", originKind: "user_input", originRef: "turn:user" });
    store.finalizeTurn({ turnId: "turn", status: "complete", outcomeCapsule: { sessionId: "session", turnId: "turn", generation: 1, outcome: "delivered", requestMessageId: user.id } });
    await ingestConversationMemory({ context, source: { kind: "conversation_turn", session_id: "session", turn_id: "turn", outcome_generation: 1 } });
    const path = join(root, "cognition/memory/generations", descriptor.generation_id, "manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.embedding = { model: "test/embedding", dimension: 2, pooling: "cls", normalize: true,
      version: "a".repeat(64), max_tokens: 8192, transformers_version: "test", node_runtime_version: process.version,
      bun_runtime_version: Bun.version, tokenizer_asset_sha256: "b".repeat(64), model_asset_sha256: "c".repeat(64) };
    writeFileSync(path, JSON.stringify(manifest));
    const result = await recallSourceBackedMemory({ context, cue: "cobalt telescope", includeVector: true, includeInternal: false,
      limit: 5, scope: "current_session", projectFilter: "any", projectIds: [], sessionIds: [], asOf: new Date().toISOString(),
      runtime: { sessionId: "session", turnId: "query", currentUserMessage: "cobalt telescope", nativeOperationId: "query", projectId: null } });
    expect(result.status).toBe("partial");
    expect(result.results.some((item) => item.evidence.some((evidence) => evidence.excerpt.includes("ceramic mount")))).toBe(true);
    expect(result.coverage.vectors.codes).toContain("vector_deadline");
    expect(result.coverage.source.codes).not.toContain("operation_deadline");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
