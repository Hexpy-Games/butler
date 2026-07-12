import { expect, test } from "bun:test";
import {
  addDirectTurnUsage,
  beforeDirectTurnModelRequest,
  createDirectTurnBudget,
  directTurnBudgetState,
  hydrateDirectTurnBudget,
  promptUsageSectionsFromPrompt,
  recentConversationBudgetForTurn,
  snapshotDirectTurnBudget,
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

test("direct turn budget reports warning and exhaustion from real usage mutations", () => {
  const budget = createDirectTurnBudget("turn-budget-usage");

  for (let index = 0; index < 25; index += 1) {
    beforeDirectTurnModelRequest(budget);
  }
  addDirectTurnUsage({
    budget,
    promptTokens: 176_000,
    cachedTokens: 200_000,
    outputTokens: 10,
    totalTokens: null,
  });

  expect(directTurnBudgetState(budget)).toEqual(expect.objectContaining({
    status: "warning",
    requestCount: 25,
    promptTokens: 176_000,
    cachedTokens: 176_000,
    outputTokens: 10,
    totalTokens: 176_010,
  }));

  for (let index = 0; index < 7; index += 1) {
    beforeDirectTurnModelRequest(budget);
  }

  expect(directTurnBudgetState(budget).status).toBe("exhausted");
});

test("direct turn budget hydrates from a continuation snapshot", () => {
  const budget = createDirectTurnBudget("turn-budget-snapshot");
  for (let index = 0; index < 3; index += 1) {
    beforeDirectTurnModelRequest(budget);
  }
  addDirectTurnUsage({
    budget,
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
    requestCount: 0,
    promptTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    maxRequests: 32,
    cumulativeRequestCount: 3,
    cumulativePromptTokens: 1000,
    cumulativeCachedTokens: 800,
    cumulativeOutputTokens: 120,
    cumulativeTotalTokens: 1120,
  });
});

test("continuation hydration preserves cumulative usage while opening a new safety window", () => {
  const budget = createDirectTurnBudget("turn-budget-resume-window");
  for (let index = 0; index < 32; index += 1) beforeDirectTurnModelRequest(budget);
  expect(directTurnBudgetState(budget).status).toBe("exhausted");

  const resumed = hydrateDirectTurnBudget(
    "turn-budget-resume-window",
    snapshotDirectTurnBudget(budget),
  );
  expect(directTurnBudgetState(resumed)).toMatchObject({
    status: "ok",
    requestCount: 0,
    cumulativeRequestCount: 32,
  });
  beforeDirectTurnModelRequest(resumed);
  expect(snapshotDirectTurnBudget(resumed).modelRequestsUsed).toBe(33);
  expect(directTurnBudgetState(resumed)).toMatchObject({
    requestCount: 1,
    cumulativeRequestCount: 33,
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
