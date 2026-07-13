import { expect, test } from "bun:test";
import {
  addDirectTurnUsage,
  beforeDirectTurnModelRequest,
  canRolloverDirectTurnBudget,
  createDirectTurnBudget,
  directTurnBudgetState,
  directTurnPartitionBudgetState,
  hydrateDirectTurnBudget,
  promptUsageSectionsFromPrompt,
  recentConversationBudgetForTurn,
  snapshotDirectTurnBudget,
  snapshotDirectTurnBudgetForRollover,
} from "../../packages/butler-agent/src/agent/turn/direct-turn-budget.ts";

test("direct turn budget starts with the runtime request and token limits", () => {
  const budget = createDirectTurnBudget("turn-budget-test");

  expect(directTurnBudgetState(budget)).toEqual({
    status: "ok",
    requestCount: 0,
    maxRequests: 32,
    promptTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    maxPromptTokens: 220_000,
    maxOutputTokens: 80_000,
    maxTotalTokens: 300_000,
    cumulativeRequestCount: 0,
    cumulativePromptTokens: 0,
    cumulativeCachedTokens: 0,
    cumulativeOutputTokens: 0,
    cumulativeTotalTokens: 0,
  });
});

test("direct turn budget warns without authorizing a request beyond a hard token cap", () => {
  const budget = createDirectTurnBudget("turn-budget-usage");

  for (let index = 0; index < 19; index += 1) {
    beforeDirectTurnModelRequest(budget, { partition: "execution" });
  }
  addDirectTurnUsage({
    budget,
    partition: "execution",
    promptTokens: 128_000,
    cachedTokens: 200_000,
    outputTokens: 10,
    totalTokens: null,
  });

  expect(directTurnPartitionBudgetState(budget, "execution")).toEqual(expect.objectContaining({
    status: "warning",
    requestCount: 19,
    promptTokens: 128_000,
    cachedTokens: 128_000,
    outputTokens: 10,
    totalTokens: 128_010,
  }));

  expect(() => beforeDirectTurnModelRequest(budget, {
    partition: "execution",
    admittedPromptTokens: 32_001,
    requestedOutputTokens: 1,
  })).toThrow("budget exhausted");
  expect(directTurnPartitionBudgetState(budget, "execution").requestCount).toBe(19);
});

test("direct turn budget hydrates from a continuation snapshot", () => {
  const budget = createDirectTurnBudget("turn-budget-snapshot");
  for (let index = 0; index < 3; index += 1) {
    beforeDirectTurnModelRequest(budget, { partition: "execution" });
  }
  addDirectTurnUsage({
    budget,
    partition: "execution",
    promptTokens: 1000,
    cachedTokens: 800,
    outputTokens: 120,
    totalTokens: 1120,
  });

  const hydrated = hydrateDirectTurnBudget(
    "turn-budget-snapshot",
    snapshotDirectTurnBudget(budget),
  );

  expect(directTurnBudgetState(hydrated)).toMatchObject({
    requestCount: 3,
    promptTokens: 1000,
    cachedTokens: 800,
    outputTokens: 120,
    totalTokens: 1120,
    maxRequests: 32,
    cumulativeRequestCount: 3,
    cumulativePromptTokens: 1000,
    cumulativeCachedTokens: 800,
    cumulativeOutputTokens: 120,
    cumulativeTotalTokens: 1120,
  });
});

test("eligible continuation hydration preserves lifetime spend and opens a fresh execution slice", () => {
  const budget = createDirectTurnBudget("turn-budget-resume-window");
  for (let index = 0; index < 24; index += 1) {
    beforeDirectTurnModelRequest(budget, { partition: "execution" });
  }
  expect(directTurnPartitionBudgetState(budget, "execution").status).toBe("exhausted");
  const error = Object.assign(new Error("budget exhausted"), {
    code: "prompt_usage_model_call_budget_exhausted",
    partition: "execution",
  });
  expect(canRolloverDirectTurnBudget(budget, error)).toBe(true);

  const resumed = hydrateDirectTurnBudget(
    "turn-budget-resume-window",
    snapshotDirectTurnBudgetForRollover(budget),
  );
  expect(directTurnPartitionBudgetState(resumed, "execution")).toMatchObject({
    status: "ok",
    requestCount: 0,
  });
  expect(snapshotDirectTurnBudget(resumed)).toMatchObject({
    executionSlice: 2,
    modelRequestsUsed: 0,
    cumulativeUsage: { modelRequestsUsed: 24 },
  });
  beforeDirectTurnModelRequest(resumed, { partition: "execution" });
  expect(directTurnBudgetState(resumed)).toMatchObject({
    requestCount: 1,
    cumulativeRequestCount: 25,
  });
});

test("a request that cannot fit an empty slice is never rollover eligible", () => {
  const budget = createDirectTurnBudget("turn-budget-oversized-request");
  beforeDirectTurnModelRequest(budget, { partition: "execution" });
  let failure: unknown;
  try {
    beforeDirectTurnModelRequest(budget, {
      partition: "execution",
      admittedPromptTokens: 160_001,
      requestedOutputTokens: 1,
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    code: "prompt_usage_model_call_budget_exhausted",
    rolloverEligible: false,
  });
  expect(canRolloverDirectTurnBudget(budget, failure)).toBe(false);
});

test("monotonic lifetime usage is telemetry and does not terminalize a productive slice", () => {
  const snapshot = snapshotDirectTurnBudget(createDirectTurnBudget("turn-budget-lifetime-usage"));
  snapshot.modelRequestsUsed = 1;
  snapshot.cumulativeUsage = {
    modelRequestsUsed: 9_600,
    promptTokens: 1_000_000,
    cachedTokens: 500_000,
    outputTokens: 10_000,
    totalTokens: 1_010_000,
  };
  const budget = hydrateDirectTurnBudget("turn-budget-lifetime-usage", snapshot);
  expect(directTurnBudgetState(budget).status).toBe("ok");
  beforeDirectTurnModelRequest(budget, {
    partition: "execution",
    admittedPromptTokens: 100,
    requestedOutputTokens: 100,
  });
  expect(budget.modelRequestsUsed).toBe(2);
  expect(budget.cumulativeUsage.modelRequestsUsed).toBe(9_601);
});

test("execution and review cannot consume the finalization reserve", () => {
  const budget = createDirectTurnBudget("turn-budget-partitions");
  beforeDirectTurnModelRequest(budget, {
    partition: "execution",
    admittedPromptTokens: 100,
    requestedOutputTokens: 100,
  });
  addDirectTurnUsage({
    budget,
    partition: "execution",
    promptTokens: 100,
    cachedTokens: 0,
    outputTokens: 50,
    totalTokens: 150,
  });
  beforeDirectTurnModelRequest(budget, {
    partition: "review",
    admittedPromptTokens: 100,
    requestedOutputTokens: 100,
  });

  expect(directTurnPartitionBudgetState(budget, "finalization")).toMatchObject({
    status: "ok",
    requestCount: 0,
    promptTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    maxRequests: 4,
    maxPromptTokens: 30_000,
    maxOutputTokens: 20_000,
    maxTotalTokens: 50_000,
  });
});

test("projected admitted prompt and requested output reject before mutation for every partition", () => {
  for (const partition of ["execution", "review", "finalization"] as const) {
    const budget = createDirectTurnBudget(`turn-budget-${partition}`);
    const state = directTurnPartitionBudgetState(budget, partition);
    expect(() => beforeDirectTurnModelRequest(budget, {
      partition,
      admittedPromptTokens: state.maxPromptTokens! + 1,
      requestedOutputTokens: 1,
    })).toThrow("budget exhausted");
    expect(directTurnPartitionBudgetState(budget, partition).requestCount).toBe(0);
    expect(directTurnBudgetState(budget).requestCount).toBe(0);
  }
});

test("phase admission and spend admission commit atomically", () => {
  const budget = createDirectTurnBudget("turn-budget-atomic");
  expect(() => beforeDirectTurnModelRequest(budget, {
    partition: "review",
    admittedPromptTokens: 100,
    requestedOutputTokens: 100,
    beforeCommit: () => {
      throw new Error("phase budget exhausted");
    },
  })).toThrow("phase budget exhausted");
  expect(directTurnBudgetState(budget).requestCount).toBe(0);
  expect(directTurnPartitionBudgetState(budget, "review").requestCount).toBe(0);
});

test("legacy snapshots hydrate into execution without inventing finalization spend", () => {
  const legacy = snapshotDirectTurnBudget(createDirectTurnBudget("turn-budget-legacy"));
  delete legacy.partitions;
  legacy.modelRequestsUsed = 2;
  legacy.promptTokens = 500;
  legacy.cachedTokens = 100;
  legacy.outputTokens = 50;
  legacy.totalTokens = 550;

  const hydrated = hydrateDirectTurnBudget("turn-budget-legacy", legacy);
  expect(directTurnPartitionBudgetState(hydrated, "execution")).toMatchObject({
    requestCount: 2,
    promptTokens: 500,
    outputTokens: 50,
  });
  expect(directTurnPartitionBudgetState(hydrated, "finalization")).toMatchObject({
    requestCount: 0,
    totalTokens: 0,
  });
});

test("prompt usage attribution keeps only populated prompt sections", () => {
  const sections = promptUsageSectionsFromPrompt({
    promptContextChars: 0,
    compactionContextChars: 120,
    feedbackBufferContextChars: 0,
    workingMemoryContextChars: 80,
    recentConversationChars: 0,
    recallContextChars: 12,
    inboundMessageChars: 20,
  });

  expect(sections.map((section) => section.id)).toEqual([
    "compaction_context",
    "working_memory",
    "recall_context",
    "inbound_message",
  ]);
  expect(sections.every((section) => section.estimatedTokens > 0)).toBe(true);
});

test("prompt usage attribution estimates known character counts without synthetic tokenization", () => {
  const sections = promptUsageSectionsFromPrompt({
    promptContextChars: 0,
    compactionContextChars: 380,
    feedbackBufferContextChars: 0,
    workingMemoryContextChars: 0,
    recentConversationChars: 0,
    recallContextChars: 0,
    inboundMessageChars: 0,
  });

  expect(sections).toEqual([{
    id: "compaction_context",
    chars: 380,
    estimatedTokens: 95,
  }]);
});

test("prompt usage attribution stays bounded for large granular character counts", () => {
  const startedAt = performance.now();
  const sections = promptUsageSectionsFromPrompt({
    promptContextChars: 1_000_000,
    promptContextSections: [
      { id: "active_persona_reminder", chars: 200_000 },
      { id: "project_memory", chars: 200_000 },
      { id: "runtime_state", chars: 200_000 },
    ],
    compactionContextChars: 200_000,
    feedbackBufferContextChars: 0,
    workingMemoryContextChars: 200_000,
    recentConversationChars: 200_000,
    recallContextChars: 0,
    inboundMessageChars: 380,
  });
  const elapsedMs = performance.now() - startedAt;

  expect(sections).toEqual([
    { id: "active_persona_reminder", chars: 200_000, estimatedTokens: 50_000 },
    { id: "project_memory", chars: 200_000, estimatedTokens: 50_000 },
    { id: "runtime_state", chars: 200_000, estimatedTokens: 50_000 },
    { id: "prompt_context_other", chars: 400_000, estimatedTokens: 100_000 },
    { id: "compaction_context", chars: 200_000, estimatedTokens: 50_000 },
    { id: "working_memory", chars: 200_000, estimatedTokens: 50_000 },
    { id: "recent_conversation", chars: 200_000, estimatedTokens: 50_000 },
    { id: "inbound_message", chars: 380, estimatedTokens: 95 },
  ]);
  expect(elapsedMs).toBeLessThan(100);
});

test("direct turns compact recent conversation budget only when compaction exists", () => {
  expect(recentConversationBudgetForTurn({
    configuredBudget: 8_000,
    compactionContext: "",
  })).toBe(8_000);
  expect(recentConversationBudgetForTurn({
    configuredBudget: 8_000,
    compactionContext: "Compacted session state",
  })).toBe(2_000);
  expect(recentConversationBudgetForTurn({
    configuredBudget: 500,
    compactionContext: "Compacted session state",
  })).toBe(500);
});
