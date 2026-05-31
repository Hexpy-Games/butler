import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { readOperationalMetricEvents } from "../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";
import {
  createCachedRecallMemoryRunner,
  recallFromCorpus,
  recallMemory,
  type RecallCorpus,
} from "../../packages/butler-agent/src/agent/cognition/memory/recall/engine.ts";

const now = Date.parse("2026-04-26T00:00:00.000Z");

function baseCorpus(): RecallCorpus {
  return {
    hotCacheHints: ["떡볶이, 식단, 로제 선택"],
    nodes: [
      { id: "n-tteokbokki", type: "entity", name: "떡볶이", degree: 2 },
      { id: "n-rose", type: "preference", name: "로제 떡볶이", degree: 1 },
      { id: "n-diet", type: "goal", name: "저탄수 식단", degree: 1 },
      { id: "n-runtime", type: "decision", name: "런타임", degree: 2 },
      { id: "n-hub", type: "project", name: "butler", degree: 40 },
    ],
    edges: [
      { sourceId: "n-tteokbokki", targetId: "n-rose", relType: "likes", weight: 1 },
      { sourceId: "n-tteokbokki", targetId: "n-diet", relType: "related_to", weight: 1 },
      { sourceId: "n-runtime", targetId: "n-hub", relType: "belongs_to", weight: 1 },
      { sourceId: "n-hub", targetId: "n-rose", relType: "related_to", weight: 1 },
    ],
    candidates: [
      {
        id: "ep-rose",
        summary: "지난번에는 로제 떡볶이를 골랐다.",
        text: "사용자는 지난번 로제 떡볶이를 골랐고 만족했다.",
        source: "vector",
        originalSource: "task-memory",
        provenance: ["transcript:food-1"],
        relatedNodes: ["n-rose"],
        timestamp: Math.floor(now / 1000),
        frequency: 2,
      },
      {
        id: "ep-diet",
        summary: "최근에는 저탄수 식단 목표가 활성화되어 있다.",
        text: "사용자는 최근 저탄수 식단을 진행 중이라 야식 선택에 주의하기로 했다.",
        source: "graph",
        originalSource: "graph",
        provenance: ["transcript:diet-1"],
        relatedNodes: ["n-diet"],
        timestamp: Math.floor(now / 1000),
        frequency: 1,
      },
      {
        id: "ep-hub",
        summary: "Butler 프로젝트에는 많은 하위 주제가 있다.",
        text: "Butler 프로젝트에는 transport, memory, search, install 등 많은 주제가 있다.",
        source: "graph",
        originalSource: "graph",
        provenance: ["transcript:hub"],
        relatedNodes: ["n-hub"],
        timestamp: Math.floor(now / 1000),
        frequency: 8,
      },
    ],
  };
}

test("associative recall activates indirect graph memories and keeps provenance", () => {
  const result = recallFromCorpus({
    cue: "아 떡볶이 먹고 싶다",
    corpus: baseCorpus(),
    now,
    limit: 3,
    minScore: 0.1,
  });

  expect(result.abstained).toBe(false);
  expect(result.items.map((item) => item.provenance[0])).toContain("transcript:food-1");
  expect(result.items.map((item) => item.provenance[0])).toContain("transcript:diet-1");
  expect(result.items[0]?.score_breakdown.graph_activation).toBeGreaterThan(0);
  expect(result.items.some((item) => item.source === "hybrid" || item.source === "graph")).toBe(true);
});

test("associative recall penalizes hub nodes and superseded memories", () => {
  const corpus = baseCorpus();
  corpus.candidates.push({
    id: "ep-old-runtime",
    summary: "Node 전환을 검토했다.",
    text: "예전에는 Node 런타임 이전을 검토했다.",
    source: "vector",
    originalSource: "task-memory",
    provenance: ["transcript:old-runtime"],
    relatedNodes: ["n-runtime"],
    supersededBy: "ep-managed-bun",
    frequency: 5,
  }, {
    id: "ep-managed-bun",
    summary: "최종 결정은 Butler-managed Bun 유지다.",
    text: "최종 결정은 Bun을 Butler-managed runtime으로 유지하는 것이다.",
    source: "vector",
    originalSource: "task-memory",
    provenance: ["transcript:managed-bun"],
    relatedNodes: ["n-runtime"],
    explicitSalience: 0.8,
  });

  const result = recallFromCorpus({
    cue: "런타임은 Node로 옮기기로 했나요?",
    corpus,
    now,
  });

  expect(result.items[0]?.provenance[0]).toBe("transcript:managed-bun");
  const old = result.items.find((item) => item.provenance[0] === "transcript:old-runtime");
  expect(old).toBeUndefined();
});

test("associative recall abstains on unsupported memories", () => {
  const result = recallFromCorpus({
    cue: "지난번에 산 운동화 색깔이 뭐였죠?",
    corpus: baseCorpus(),
    now,
  });

  expect(result.abstained).toBe(true);
  expect(result.items).toHaveLength(0);
});

test("associative recall does not surface recency-only candidates", () => {
  const result = recallFromCorpus({
    cue: "완전히 새로운 주제입니다",
    now,
    corpus: {
      hotCacheHints: [],
      nodes: [],
      edges: [],
      candidates: [{
        id: "recent-no-evidence",
        summary: "최근 대화지만 현재 질의와 관계가 없다.",
        text: "최근 대화지만 현재 질의와 관계가 없다.",
        source: "vector",
        originalSource: "task-memory",
        provenance: ["transcript:recent"],
        timestamp: Math.floor(now / 1000),
        frequency: 8,
      }],
    },
  });

  expect(result.abstained).toBe(true);
});

test("associative recall applies contradiction penalties", () => {
  const result = recallFromCorpus({
    cue: "보고는 자세하게 하면 되나요?",
    now,
    minScore: 0.01,
    corpus: {
      hotCacheHints: [],
      nodes: [
        { id: "reporting", type: "preference", name: "보고", degree: 1 },
      ],
      edges: [],
      candidates: [{
        id: "old-reporting",
        summary: "보고는 자세하게 한다.",
        text: "예전에는 보고를 자세하게 하는 편이 좋다고 추정했다.",
        source: "vector",
        originalSource: "task-memory",
        provenance: ["transcript:old-reporting"],
        relatedNodes: ["reporting"],
        contradicts: ["new-reporting"],
      }, {
        id: "new-reporting",
        summary: "최종 선호는 핵심만 간결하게 보고하는 것이다.",
        text: "사용자는 최종적으로 핵심만 간결하게 보고하기를 선호한다고 말했다.",
        source: "explicit",
        originalSource: "rules",
        provenance: ["rules:reporting"],
        relatedNodes: ["reporting"],
        explicitSalience: 1,
      }],
    },
  });

  expect(result.items[0]?.provenance[0]).toBe("rules:reporting");
  const old = result.items.find((item) => item.provenance[0] === "transcript:old-reporting");
  expect(old?.score_breakdown.conflict_penalty ?? 0).toBeGreaterThan(0);
});

test("file-backed recall memory returns explicit and graph-backed results", () => {
  const tempDir = join(tmpdir(), `butler-recall-${Date.now()}-${Math.random()}`);
  try {
    mkdirSync(join(tempDir, "cognition", "memory", "rules"), { recursive: true });
    mkdirSync(join(tempDir, "cognition", "memory", "tasks"), { recursive: true });
    mkdirSync(join(tempDir, "cognition", "memory", "db"), { recursive: true });
    writeFileSync(join(tempDir, "cognition", "memory", "rules", "report.md"), "Always keep final reports concise.\n", "utf8");
    writeFileSync(join(tempDir, "cognition", "memory", "tasks", "search.md"), "검색 공급자 결정: DuckDuckGo 기본, Brave fallback.\n", "utf8");

    const db = new Database(join(tempDir, "cognition", "memory", "db", "graph.sqlite"));
    db.exec(`
      CREATE TABLE entities (id TEXT, type TEXT, name TEXT);
      CREATE TABLE edges (id INTEGER, source_id TEXT, target_id TEXT, rel_type TEXT, weight REAL);
      CREATE TABLE entity_mentions (id INTEGER, entity_id TEXT, session_id TEXT, timestamp INTEGER, snippet TEXT);
      INSERT INTO entities VALUES ('duck', 'decision', '검색 공급자 DuckDuckGo');
      INSERT INTO entities VALUES ('fallback', 'decision', 'Brave fallback');
      INSERT INTO edges VALUES (1, 'duck', 'fallback', 'supports', 1.0);
      INSERT INTO entity_mentions VALUES (1, 'duck', 'butler_main_c0', 1777210000, 'DuckDuckGo를 기본 검색 공급자로 결정했다.');
    `);
    db.close();

    const result = recallMemory({
      butlerData: tempDir,
      cue: "검색 공급자 DuckDuckGo",
      now,
      minScore: 0.05,
    });

    expect(result.abstained).toBe(false);
    expect(result.items.some((item) => item.provenance.includes(join(tempDir, "cognition", "memory", "tasks", "search.md")))).toBe(true);
    expect(result.items.some((item) => item.provenance.includes("graph:butler_main_c0"))).toBe(true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("cached recall runner avoids reloading the corpus on every turn", () => {
  const tempDir = join(tmpdir(), `butler-recall-cache-${Date.now()}-${Math.random()}`);
  try {
    mkdirSync(join(tempDir, "cognition", "memory", "tasks"), { recursive: true });
    const path = join(tempDir, "cognition", "memory", "tasks", "decision.md");
    writeFileSync(path, "검색 공급자는 DuckDuckGo로 결정했다.\n", "utf8");
    const runner = createCachedRecallMemoryRunner({
      butlerData: tempDir,
      ttlMs: 60_000,
    });

    expect(runner({
      butlerData: tempDir,
      cue: "검색 공급자 뭐였죠?",
    }).abstained).toBe(false);

    writeFileSync(path, "날씨 도구는 다른 결정이다.\n", "utf8");

    expect(runner({
      butlerData: tempDir,
      cue: "날씨 도구는 뭐였죠?",
    }).abstained).toBe(true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("file-backed recall emits raw-text-free operational metrics", () => {
  const tempDir = join(tmpdir(), `butler-recall-metrics-${Date.now()}-${Math.random()}`);
  try {
    mkdirSync(join(tempDir, "cognition", "memory", "rules"), { recursive: true });
    writeFileSync(join(tempDir, "cognition", "memory", "rules", "secret.md"), "SECRET_MEMORY_TEXT says concise reports matter.\n", "utf8");

    const result = recallMemory({
      butlerData: tempDir,
      cue: "SECRET_RECALL_CUE_TEXT concise reports 기억해?",
      now,
    });
    const events = readOperationalMetricEvents({
      butlerData: tempDir,
    });
    const event = events.find((candidate) => candidate.category === "memory" && candidate.name === "recall");

    expect(result.abstained).toBe(false);
    expect(event).toMatchObject({
      category: "memory",
      name: "recall",
      status: "ok",
      rawTextStored: false,
      unit: "items",
    });
    expect(event?.dimensions).toMatchObject({
      items_count: result.items.length,
      seeds_count: result.seeds.length,
      candidates_count: 1,
      shadow_baseline_items_count: 0,
      shadow_recall_gain_count: result.items.length,
      abstained: false,
      project_scoped: false,
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("SECRET_RECALL_CUE_TEXT");
    expect(serialized).not.toContain("SECRET_MEMORY_TEXT");
    expect(serialized).not.toContain("secret.md");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("recall metrics respect the shared operational metrics opt-out", () => {
  const tempDir = join(tmpdir(), `butler-recall-metrics-disabled-${Date.now()}-${Math.random()}`);
  const original = process.env.BUTLER_METRICS_ENABLED;
  try {
    mkdirSync(join(tempDir, "cognition", "memory", "rules"), { recursive: true });
    writeFileSync(join(tempDir, "cognition", "memory", "rules", "report.md"), "Always keep reports concise.\n", "utf8");
    process.env.BUTLER_METRICS_ENABLED = "false";

    recallMemory({
      butlerData: tempDir,
      cue: "보고 방식 기억해?",
      now,
    });

    expect(readOperationalMetricEvents({ butlerData: tempDir })).toHaveLength(0);
  } finally {
    if (original === undefined) delete process.env.BUTLER_METRICS_ENABLED;
    else process.env.BUTLER_METRICS_ENABLED = original;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("recall emits a safe error metric before rethrowing invalid requests", () => {
  const tempDir = join(tmpdir(), `butler-recall-metrics-error-${Date.now()}-${Math.random()}`);
  try {
    expect(() => recallMemory({
      butlerData: tempDir,
      cue: "   ",
      now,
    })).toThrow("recall cue requires text");

    const events = readOperationalMetricEvents({ butlerData: tempDir });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "memory",
      name: "recall",
      status: "error",
      rawTextStored: false,
    });
    expect(JSON.stringify(events)).not.toContain("recall cue requires text");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("cached recall runner emits safe metrics without reloading private corpus text", () => {
  const tempDir = join(tmpdir(), `butler-recall-cache-metrics-${Date.now()}-${Math.random()}`);
  try {
    mkdirSync(join(tempDir, "cognition", "memory", "tasks"), { recursive: true });
    writeFileSync(join(tempDir, "cognition", "memory", "tasks", "decision.md"), "검색 공급자는 DuckDuckGo로 결정했다.\n", "utf8");
    const runner = createCachedRecallMemoryRunner({
      butlerData: tempDir,
      ttlMs: 60_000,
    });

    runner({
      butlerData: tempDir,
      cue: "검색 공급자 뭐였죠?",
    });

    const events = readOperationalMetricEvents({ butlerData: tempDir });
    expect(events.some((event) => event.category === "memory" && event.name === "recall")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("검색 공급자");
    expect(JSON.stringify(events)).not.toContain("decision.md");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
