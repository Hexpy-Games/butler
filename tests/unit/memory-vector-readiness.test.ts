import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryGenerationHandle } from "../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts";
import type { ClaimedVectorUnit } from "../../packages/butler-agent/src/agent/cognition/memory/projection/store.ts";
import {
  countInvalidPersistedVectorReadiness,
  findPersistedVectorReceipt,
  generationVectorIdentity,
  prepareReusedGenerationVectorRows,
  writeGenerationVectorRows,
  type GenerationVectorRow,
} from "../../packages/butler-agent/src/agent/cognition/memory/recall/vector.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function nodeUnit(input: {
  unitId: string;
  jobId: string;
  sourceRevision: string;
  sourceId: string;
  observedAt: string;
  receiptJson?: string | null;
}): ClaimedVectorUnit {
  return {
    unit_id: input.unitId,
    job_id: input.jobId,
    record_kind: "node",
    owner_id: "shared-node",
    owner_revision: "shared-projection-r1",
    project_id: "project-a",
    origin_kind: "user_input",
    projection_text: "type:\"entity\"\nlabel:\"공유 노드\"",
    source_revision: input.sourceRevision,
    conversation_session_id: `session-${input.jobId}`,
    source_kind: "conversation",
    source_observed_at: input.observedAt,
    source_ids_json: JSON.stringify([input.sourceId]),
    receipt_json: input.receiptJson ?? null,
    attempt_count: 1,
    owner_nonce: `nonce-${input.unitId}`,
  };
}

describe("shared node vector readiness", () => {
  test("keeps stable payload storage separate from current source memberships", async () => {
    const root = mkdtempSync(join(tmpdir(), "butler-vector-readiness-"));
    roots.push(root);
    const generation: MemoryGenerationHandle = {
      generationId: "generation-a",
      root,
      graphPath: join(root, "graph.sqlite"),
      embedding: null,
      sourceRoot: root,
      canonicalSnapshotPath: null,
    };
    const embeddingVersion = "bge-m3:test";
    const first = nodeUnit({
      unitId: "unit-a",
      jobId: "job-a",
      sourceRevision: "source-r1",
      sourceId: "source-a",
      observedAt: "2026-09-01T00:00:00.000Z",
    });
    const identity = generationVectorIdentity({
      generationId: generation.generationId,
      recordKind: first.record_kind,
      ownerId: first.owner_id,
      ownerRevision: first.owner_revision,
      embeddingText: first.projection_text,
      ordinal: 0,
      embeddingVersion,
    });
    const firstRow: GenerationVectorRow = {
      vector_key: identity.vectorKey,
      generation: generation.generationId,
      record_kind: "node",
      owner_id: first.owner_id,
      owner_revision: first.owner_revision,
      source_revision: first.source_revision,
      embedding_chunk_id: identity.embeddingChunkId,
      embedding_version: embeddingVersion,
      project_id: first.project_id!,
      origin_kind: first.origin_kind,
      source_kind: first.source_kind,
      conversation_session_id: first.conversation_session_id,
      source_observed_at: first.source_observed_at,
      source_refs_json: first.source_ids_json,
      text: "",
      vector: [0.25, 0.75],
    };
    await writeGenerationVectorRows(generation, [firstRow]);
    const receipt = JSON.stringify({
      generation: generation.generationId,
      embedding_version: embeddingVersion,
      vector_keys: [identity.vectorKey],
      row_count: 1,
    });
    first.receipt_json = receipt;

    const second = nodeUnit({
      unitId: "unit-b",
      jobId: "job-b",
      sourceRevision: "source-r2",
      sourceId: "source-b",
      observedAt: "2026-09-02T00:00:00.000Z",
      receiptJson: receipt,
    });
    const reused = await prepareReusedGenerationVectorRows(
      generation,
      [second],
      embeddingVersion,
    );
    expect(reused).toHaveLength(1);
    await writeGenerationVectorRows(generation, reused!);

    expect(await findPersistedVectorReceipt(generation, [first], embeddingVersion)).toBeNull();
    expect(await findPersistedVectorReceipt(generation, [second], embeddingVersion)).not.toBeNull();
    expect(await countInvalidPersistedVectorReadiness(
      generation,
      [first, second],
      embeddingVersion,
    )).toBe(0);

    const wrongReceipt = {
      ...first,
      unit_id: "unit-wrong-receipt",
      receipt_json: JSON.stringify({
        generation: generation.generationId,
        embedding_version: embeddingVersion,
        vector_keys: ["wrong-vector-key"],
        row_count: 1,
      }),
    };
    expect(await countInvalidPersistedVectorReadiness(
      generation,
      [first, second, wrongReceipt],
      embeddingVersion,
    )).toBe(1);

    await writeGenerationVectorRows(generation, [{
      ...reused![0]!,
      source_revision: "unbound-r3",
      conversation_session_id: "session-unbound",
      source_observed_at: "2026-09-03T00:00:00.000Z",
      source_refs_json: JSON.stringify(["source-unbound"]),
    }]);
    expect(await countInvalidPersistedVectorReadiness(
      generation,
      [first, second],
      embeddingVersion,
    )).toBe(2);
  });
});
