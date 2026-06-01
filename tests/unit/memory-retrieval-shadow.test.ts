import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  recallFromCorpus,
  type AssociativeRecallResult,
  type RecallCorpus,
} from "../../packages/butler-agent/src/agent/cognition/memory/recall/engine.ts";
import {
  indexTranscriptLinesForQuery,
  queryMemory,
} from "../../packages/butler-agent/src/agent/cognition/memory/exact-query.ts";

const now = Date.parse("2026-06-01T00:00:00.000Z");

interface ShadowRecallCase {
  name: string;
  cue: string;
  corpus: RecallCorpus;
  expectedTopProvenance?: string;
  expectAbstain?: boolean;
}

function runShadowRecallCases(
  cases: ShadowRecallCase[],
  runner: (input: {
    cue: string;
    corpus: RecallCorpus;
    now: number;
    minScore?: number;
  }) => AssociativeRecallResult = recallFromCorpus,
): Record<string, AssociativeRecallResult> {
  const results: Record<string, AssociativeRecallResult> = {};
  for (const item of cases) {
    const result = runner({
      cue: item.cue,
      corpus: item.corpus,
      now,
      minScore: 0.05,
    });
    results[item.name] = result;
    if (item.expectAbstain) {
      expect(result.abstained, item.name).toBe(true);
      continue;
    }
    expect(result.abstained, item.name).toBe(false);
    expect(item.expectedTopProvenance, item.name).toBeDefined();
    expect(result.items[0]?.provenance[0], item.name).toBe(item.expectedTopProvenance!);
  }
  return results;
}

function retrievalCorpus(): RecallCorpus {
  return {
    hotCacheHints: [],
    nodes: [
      { id: "composer", type: "entity", name: "composer", degree: 1 },
      { id: "approval", type: "decision", name: "approval form", degree: 1 },
    ],
    edges: [
      { sourceId: "composer", targetId: "approval", relType: "decided", weight: 1 },
    ],
    candidates: [
      {
        id: "composer-form",
        summary: "Composer ask-first approval forms replace the normal input.",
        text: "The ask-first approval form should replace the composer input and render choices as vertical card items.",
        source: "vector",
        originalSource: "project-memory",
        provenance: ["memory:composer-form"],
        relatedNodes: ["composer", "approval"],
        timestamp: Math.floor(now / 1000),
        frequency: 2,
      },
      {
        id: "prior-vague-reference",
        summary: "지난번에는 retrieval planner가 참조 대상을 먼저 해소하기로 했다.",
        text: "지난번 논의에서 현재 발화만으로 target이 닫히지 않으면 최근 대화와 작업 상태를 먼저 확인하기로 했다.",
        source: "graph",
        originalSource: "graph",
        provenance: ["memory:prior-reference"],
        timestamp: Math.floor(now / 1000),
        frequency: 1,
      },
      {
        id: "unrelated",
        summary: "Release packaging has a separate app and service boundary.",
        text: "Release packaging tracks service and app manifests separately.",
        source: "vector",
        originalSource: "task-memory",
        provenance: ["memory:release"],
        timestamp: Math.floor(now / 1000),
        frequency: 4,
      },
    ],
  };
}

test("shadow baseline protects current recall behavior across key retrieval cases", () => {
  const results = runShadowRecallCases([
    {
      name: "strong lexical and graph anchor",
      cue: "composer ask first approval form",
      corpus: retrievalCorpus(),
      expectedTopProvenance: "memory:composer-form",
    },
    {
      name: "vague prior-reference recall still finds the prior discussion",
      cue: "지난번 그거 말이야",
      corpus: retrievalCorpus(),
      expectedTopProvenance: "memory:prior-reference",
    },
    {
      name: "unsupported memory abstains",
      cue: "내가 주문한 운동화 사이즈가 뭐였지",
      corpus: retrievalCorpus(),
      expectAbstain: true,
    },
  ]);

  expect(results["strong lexical and graph anchor"]?.items[0]?.score_breakdown.semantic_similarity).toBeGreaterThan(0);
  expect(results["vague prior-reference recall still finds the prior discussion"]?.items[0]?.score_breakdown.recency_score).toBeGreaterThan(0);
});

test("shadow baseline keeps exact transcript lookup on queryMemory", () => {
  const tempDir = join(tmpdir(), `butler-retrieval-shadow-${Date.now()}-${Math.random()}`);
  try {
    mkdirSync(tempDir, { recursive: true });
    indexTranscriptLinesForQuery({
      butlerData: tempDir,
      transcriptFile: "shadow.jsonl",
      lines: [
        JSON.stringify({
          eventId: "turn-1",
          sessionId: "butler/main",
          kind: "inbound",
          timestamp: "2026-05-31T12:00:00.000Z",
          payload: { message: { text: "첫 결정은 query_memory가 정확 이력 조회라는 것이다." } },
        }),
        JSON.stringify({
          eventId: "turn-2",
          sessionId: "butler/main",
          kind: "outbound",
          timestamp: "2026-05-31T12:00:10.000Z",
          payload: { message: { text: "recall_memory와 query_memory의 boundary를 분리해 두겠습니다." } },
        }),
      ],
    });

    const exact = queryMemory({
      butlerData: tempDir,
      query: "정확 이력",
      speaker: "user",
      order: "earliest",
      matchMode: "all",
      limit: 1,
    });

    expect(exact.total_matches).toBe(1);
    expect(exact.results[0]).toMatchObject({
      event_id: "turn-1",
      source: "transcript-query-index",
      speaker: "user",
      kind: "inbound",
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
