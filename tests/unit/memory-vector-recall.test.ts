import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { recallMemoryWithVector } from "../../packages/butler-agent/src/agent/cognition/memory/recall/engine.ts";
import {
  searchVectorEpisodes,
  vectorRowsToRecallCandidates,
  type VectorEpisodeBackend,
} from "../../packages/butler-agent/src/agent/cognition/memory/recall/vector.ts";

function tempButlerData(): string {
  return mkdtempSync(join(tmpdir(), "butler-vector-recall-"));
}

test("vector episode rows become vector recall candidates with semantic similarity", () => {
  const candidates = vectorRowsToRecallCandidates([{
    id: "episode-1",
    text: "The composer approval form decision came from a prior conversation episode.",
    project: "butler",
    session_id: "session-1",
    timestamp: 1_777_000_000,
    _distance: 0.25,
  }]);

  expect(candidates).toHaveLength(1);
  expect(candidates[0]?.source).toBe("vector");
  expect(candidates[0]?.provenance[0]).toBe("vector:session-1:episode-1");
  expect(candidates[0]?.vectorSimilarity).toBeGreaterThan(0);
  expect(candidates[0]?.vectorSimilarity).toBeLessThanOrEqual(1);
});

test("runtime recall can merge real vector episode hits into recall ranking", async () => {
  const butlerData = tempButlerData();
  const backend: VectorEpisodeBackend = {
    async embed() {
      return [0.1, 0.2, 0.3];
    },
    async search() {
      return [{
        id: "episode-1",
        text: "The composer approval form should replace the composer input.",
        project: "butler",
        session_id: "session-1",
        timestamp: 1_777_000_000,
        _distance: 0.1,
      }];
    },
  };

  try {
    const result = await recallMemoryWithVector({
      butlerData,
      cue: "composer approval form",
      projectId: "butler",
      vectorBackend: backend,
      minScore: 0.01,
    });

    expect(result.abstained).toBe(false);
    expect(result.items[0]?.source).toBe("vector");
    expect(result.items[0]?.score_breakdown.semantic_similarity).toBeGreaterThan(0);
    expect(result.items[0]?.score_breakdown.lexical_match).toBeGreaterThan(0);
    expect(result.diagnostics).toContain("vector=ok");
    expect(result.diagnostics).toContain("vector_candidates=1");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("vector search unavailable degrades without creating vector-labeled items", async () => {
  const butlerData = tempButlerData();
  try {
    const result = await recallMemoryWithVector({
      butlerData,
      cue: "unavailable vector backend",
      minScore: 0.01,
    });

    expect(result.abstained).toBe(true);
    expect(result.items.some((item) => item.source === "vector")).toBe(false);
    expect(result.diagnostics).toContain("vector=unavailable:lancedb-missing");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("vector connector filters project rows before producing candidates", async () => {
  const backend: VectorEpisodeBackend = {
    async embed() {
      return [0.1, 0.2, 0.3];
    },
    async search() {
      return [{
        id: "butler-row",
        text: "Butler project memory episode.",
        project: "butler",
        session_id: "s1",
      }, {
        id: "other-row",
        text: "Other project memory episode.",
        project: "other",
        session_id: "s2",
      }];
    },
  };

  const butlerData = tempButlerData();
  try {
    const result = await searchVectorEpisodes({
      butlerData,
      query: "project memory",
      projectId: "butler",
      backend,
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.provenance[0]).toBe("vector:s1:butler-row");
    expect(result.diagnostics).toContain("vector_candidates=1");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
