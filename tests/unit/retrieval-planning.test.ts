import { expect, test } from "bun:test";
import {
  buildFallbackRetrievalPlan,
  buildRetrievalPlanningInstructions,
  createRetrievalPlan,
  normalizeRetrievalPlan,
} from "../../packages/butler-agent/src/agent/cognition/memory/retrieval-planning.ts";

test("retrieval planner keeps decisions structured and evidence-based for self-contained requests", async () => {
  const result = await createRetrievalPlan({
    request: "내 코드 리뷰 선호 규칙 기억해?",
    runPrompt: async () => JSON.stringify({
      self_sufficient: true,
      missing_referents: [],
      strategies: ["read_explicit_memory", "search_lexical_memory"],
      generated_queries: [
        { strategy: "read_explicit_memory", query: "code review preference rules" },
        { strategy: "search_lexical_memory", query: "code review preference rules" },
      ],
      evidence_required: ["explicit_rule_hit", "project_memory_hit"],
      max_latency_ms: 700,
    }),
  });

  expect(result.usedPlanner).toBe(true);
  expect(result.attempts).toBe(1);
  expect(result.plan.self_sufficient).toBe(true);
  expect(result.plan.strategies).toEqual(["read_explicit_memory", "search_lexical_memory"]);
  expect(result.plan.evidence_required).toEqual(["explicit_rule_hit", "project_memory_hit"]);
});

test("retrieval planner can choose recent context and task state for underspecified requests", async () => {
  const result = await createRetrievalPlan({
    request: "아까 정한 방식대로 계속해줘",
    recentContext: "사용자는 composer ask-first form 배치를 결정했다.",
    activeTaskSummary: "BRP planner task is active.",
    runPrompt: async () => JSON.stringify({
      self_sufficient: false,
      missing_referents: ["target", "prior_decision", "active_task"],
      strategies: ["read_recent_context", "read_task_state", "search_vector_episode"],
      generated_queries: [
        { strategy: "search_vector_episode", query: "composer ask-first form decision" },
      ],
      evidence_required: ["recent_turn_hit", "task_continuity", "vector_episode_hit"],
      max_latency_ms: 800,
    }),
  });

  expect(result.plan.self_sufficient).toBe(false);
  expect(result.plan.missing_referents).toEqual(["target", "prior_decision", "active_task"]);
  expect(result.plan.strategies).toEqual(["read_recent_context", "read_task_state", "search_vector_episode"]);
  expect(result.plan.generated_queries).toContainEqual({
    strategy: "search_vector_episode",
    query: "composer ask-first form decision",
  });
});

test("retrieval planner separates exact transcript lookup from associative recall", async () => {
  const result = await createRetrievalPlan({
    request: "내가 처음 이 말을 한 정확한 문장을 찾아줘",
    runPrompt: async () => JSON.stringify({
      self_sufficient: true,
      missing_referents: [],
      strategies: ["query_exact_transcript", "read_recent_context"],
      generated_queries: [
        { strategy: "query_exact_transcript", query: "처음 이 말을 한 정확한 문장" },
      ],
      evidence_required: ["exact_quote", "recent_turn_hit"],
      max_latency_ms: 600,
    }),
  });

  expect(result.plan.strategies).toEqual(["query_exact_transcript", "read_recent_context"]);
  expect(result.plan.evidence_required).toEqual(["exact_quote", "recent_turn_hit"]);
  expect(result.plan.generated_queries[0]).toEqual({
    strategy: "query_exact_transcript",
    query: "처음 이 말을 한 정확한 문장",
  });
});

test("retrieval planner normalizes enum fields and drops unselected query strategies", () => {
  const plan = normalizeRetrievalPlan({
    self_sufficient: false,
    missing_referents: ["target", "unsupported", "target"],
    strategies: ["search_lexical_memory", "unknown", "read_graph_memory"],
    generated_queries: [
      { strategy: "search_vector_episode", query: "should drop" },
      { strategy: "search_lexical_memory", query: "runtime recall" },
      { strategy: "search_lexical_memory", query: "runtime recall" },
    ],
    evidence_required: ["project_memory_hit", "nonsense", "graph_relation_hit"],
    max_latency_ms: 50_000,
  }, {
    request: "runtime recall",
  });

  expect(plan.missing_referents).toEqual(["target"]);
  expect(plan.strategies).toEqual(["search_lexical_memory", "read_graph_memory"]);
  expect(plan.generated_queries).toEqual([
    { strategy: "search_lexical_memory", query: "runtime recall" },
  ]);
  expect(plan.evidence_required).toEqual(["project_memory_hit", "graph_relation_hit"]);
  expect(plan.max_latency_ms).toBe(10_000);
});

test("retrieval planner accepts evidence-required-only plans", async () => {
  const result = await createRetrievalPlan({
    request: "runtime decision evidence",
    runPrompt: async () => JSON.stringify({
      self_sufficient: true,
      missing_referents: [],
      strategies: [],
      generated_queries: [],
      evidence_required: ["project_memory_hit"],
      max_latency_ms: 600,
    }),
  });

  expect(result.usedPlanner).toBe(true);
  expect(result.fallbackReason).toBeUndefined();
  expect(result.plan.strategies).toEqual([]);
  expect(result.plan.generated_queries).toEqual([]);
  expect(result.plan.evidence_required).toEqual(["project_memory_hit"]);
});

test("invalid planner output falls back to conservative local retrieval without blocking", async () => {
  let calls = 0;
  const result = await createRetrievalPlan({
    request: "지난번 그 결정 뭐였지?",
    maxLatencyMs: 200,
    runPrompt: async () => {
      calls += 1;
      return calls === 1 ? "not-json" : JSON.stringify({ strategies: [] });
    },
  });

  expect(result.usedPlanner).toBe(true);
  expect(result.attempts).toBe(2);
  expect(result.fallbackReason).toBeTruthy();
  expect(result.plan).toEqual(buildFallbackRetrievalPlan({
    request: "지난번 그 결정 뭐였지?",
    maxLatencyMs: 200,
  }));
  expect(result.plan.strategies).toContain("read_recent_context");
  expect(result.plan.strategies).toContain("query_exact_transcript");
  expect(result.plan.strategies).toContain("search_vector_episode");
});

test("retrieval planning instructions reject dictionary classification", () => {
  const instructions = buildRetrievalPlanningInstructions();

  expect(instructions).toContain("referential completeness");
  expect(instructions).toContain("Do not classify by fixed word lists");
  expect(instructions).not.toContain("그거");
  expect(instructions).not.toContain("지난번");
});
