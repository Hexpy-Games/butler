import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cognitionMemoryRoot } from "../../packages/butler-agent/src/agent/cognition/paths.ts";
import { recallMemoryWithVector } from "../../packages/butler-agent/src/agent/cognition/memory/recall/engine.ts";
import {
  createLanceDbMemoryVectorBackend,
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

test("vector connector times out the full query operation", async () => {
  const backend: VectorEpisodeBackend = {
    async embed() {
      return [0.1, 0.2, 0.3];
    },
    async search() {
      return await new Promise(() => {});
    },
  };

  const butlerData = tempButlerData();
  const startedAt = performance.now();
  try {
    const result = await searchVectorEpisodes({
      butlerData,
      query: "slow vector query",
      backend,
      timeoutMs: 250,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1000);
    expect(result.candidates).toHaveLength(0);
    expect(result.diagnostics).toContain("vector=unavailable:query-timeout");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("runtime vector recall bounds expanded queries without serial timeout stacking", async () => {
  const backend: VectorEpisodeBackend = {
    async embed() {
      return [0.1, 0.2, 0.3];
    },
    async search() {
      return await new Promise(() => {});
    },
  };

  const butlerData = tempButlerData();
  const startedAt = performance.now();
  try {
    const result = await recallMemoryWithVector({
      butlerData,
      cue: "slow vector recall",
      vectorQueries: ["alternate vector query", "third vector query"],
      vectorBackend: backend,
      vectorTimeoutMs: 250,
      minScore: 0.01,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(600);
    expect(result.items).toHaveLength(0);
    expect(result.diagnostics.filter((item) => item === "vector=unavailable:query-timeout"))
      .toHaveLength(3);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("vector connector opens a circuit after repeated backend failures", async () => {
  let searchCalls = 0;
  const backend: VectorEpisodeBackend = {
    async embed() {
      return [0.1, 0.2, 0.3];
    },
    async search() {
      searchCalls += 1;
      throw new Error("backend unavailable");
    },
  };

  const butlerData = tempButlerData();
  try {
    for (let index = 0; index < 3; index += 1) {
      const result = await searchVectorEpisodes({
        butlerData,
        query: `failing vector query ${index}`,
        backend,
      });
      expect(result.diagnostics).toContain("vector=unavailable:query-failed");
    }

    const blocked = await searchVectorEpisodes({
      butlerData,
      query: "blocked vector query",
      backend,
    });

    expect(searchCalls).toBe(3);
    expect(blocked.candidates).toHaveLength(0);
    expect(blocked.diagnostics).toContain("vector=unavailable:circuit-open");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("vector connector overfetches before post-filtering when backend cannot prefilter projects", async () => {
  let observedLimit = 0;
  const backend: VectorEpisodeBackend = {
    supportsProjectFilter: false,
    async embed() {
      return [0.1, 0.2, 0.3];
    },
    async search(input) {
      observedLimit = input.limit;
      return [{
        id: "other-row",
        text: "Other project memory episode.",
        project: "other",
        session_id: "s-other",
        _distance: 0.01,
      }, {
        id: "butler-row",
        text: "Butler project memory episode.",
        project: "butler",
        session_id: "s-butler",
        _distance: 0.2,
      }].slice(0, input.limit);
    },
  };

  const butlerData = tempButlerData();
  try {
    const result = await searchVectorEpisodes({
      butlerData,
      query: "project memory",
      projectId: "butler",
      backend,
      limit: 1,
    });

    expect(observedLimit).toBeGreaterThan(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.provenance[0]).toBe("vector:s-butler:butler-row");
    expect(result.diagnostics).toContain("vector_project_filter=postfilter");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("vector connector passes project filter to backends that support prefiltering", async () => {
  let observedProjectId: string | undefined;
  let observedLimit = 0;
  const backend: VectorEpisodeBackend = {
    supportsProjectFilter: true,
    async embed() {
      return [0.1, 0.2, 0.3];
    },
    async search(input) {
      observedProjectId = input.projectId;
      observedLimit = input.limit;
      return [{
        id: "butler-row",
        text: "Butler project memory episode.",
        project: "butler",
        session_id: "s-butler",
        _distance: 0.2,
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
      limit: 1,
    });

    expect(observedProjectId).toBe("butler");
    expect(observedLimit).toBe(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.diagnostics).toContain("vector_project_filter=prefilter");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("vector rows without score metadata do not receive perfect semantic similarity", () => {
  const candidates = vectorRowsToRecallCandidates([{
    id: "no-score",
    text: "A vector row without LanceDB score metadata.",
    project: "butler",
    session_id: "s1",
  }]);

  expect(candidates).toHaveLength(1);
  expect(candidates[0]?.vectorSimilarity).toBeUndefined();
});

test("real LanceDB vector backend applies project filter before vector limit", async () => {
  const lancedb = await import("@lancedb/lancedb");
  const butlerData = tempButlerData();
  const dbPath = join(cognitionMemoryRoot(butlerData), "db", "butler.lance");
  mkdirSync(dbPath, { recursive: true });
  try {
    const db = await lancedb.connect(dbPath);
    await db.createTable("butler_memory", [{
      id: "other-row",
      text: "Other project row that is closest globally.",
      project: "other",
      type: "episode",
      session_id: "s-other",
      timestamp: 1,
      source: "test",
      topic: "",
      vector: [1, 0],
    }, {
      id: "butler-row",
      text: "Butler row that should survive project filtering.",
      project: "butler",
      type: "episode",
      session_id: "s-butler",
      timestamp: 2,
      source: "test",
      topic: "",
      vector: [0.2, 0.8],
    }]);

    const result = await searchVectorEpisodes({
      butlerData,
      query: "butler project",
      projectId: "butler",
      limit: 1,
      timeoutMs: 1500,
      backend: createLanceDbMemoryVectorBackend({
        embed: async () => [1, 0],
      }),
    });

    expect(result.diagnostics).toContain("vector=ok");
    expect(result.diagnostics).toContain("vector_project_filter=prefilter");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.provenance[0]).toBe("vector:s-butler:butler-row");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
