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
    requestCount: 3,
    promptTokens: 1000,
    cachedTokens: 800,
    outputTokens: 120,
    totalTokens: 1120,
    maxRequests: 32,
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
