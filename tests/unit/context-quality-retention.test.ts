import { expect, test } from "bun:test";
import {
  evaluateOptionalModelJudgedQuality,
  evaluateQualityTradeoff,
  synthesizeEvidenceAnswer,
  summarizeQualityTradeoffs,
  type QualityFixture,
} from "../../packages/butler-agent/src/agent/context/quality-retention.ts";

function noise(label: string, count = 80): string {
  return Array.from({ length: count }, (_, index) =>
    `${label} filler turn ${index}: unrelated operational chatter and repeated details.`,
  ).join("\n");
}

const fixtures: QualityFixture[] = [
  {
    id: "food-preference-with-active-goal",
    query: "떡볶이 먹고 싶다고 했을 때 무엇을 기억해야 하나?",
    fullContext: [
      noise("food-before"),
      "User decided last time that rose tteokbokki was the selected preferred choice.",
      "User also has an active low-carb diet goal that should affect food suggestions.",
      "Older unrelated note: jajang tteokbokki was only mentioned as an option, not selected.",
      noise("food-after"),
    ].join("\n"),
    compactContext: [
      "Compaction summary:",
      "Food memory: last selected tteokbokki style was rose tteokbokki.",
      "Active constraint: low-carb diet goal should be considered when suggesting food.",
      "Supersession note: jajang tteokbokki was not the selected preference.",
    ].join("\n"),
    requiredFacts: [
      {
        id: "rose-preference",
        description: "rose tteokbokki was the last selected preference",
        evidenceTerms: ["rose tteokbokki", "selected"],
        answerTerms: ["rose tteokbokki", "selected"],
      },
      {
        id: "low-carb-goal",
        description: "active low-carb goal should constrain the suggestion",
        evidenceTerms: ["low-carb", "goal"],
        answerTerms: ["low-carb", "goal"],
      },
    ],
    forbiddenFacts: [{
      id: "wrong-jajang-selection",
      description: "jajang tteokbokki was selected",
      evidenceTerms: ["jajang tteokbokki", "selected"],
      answerTerms: ["jajang tteokbokki was selected"],
    }],
  },
  {
    id: "superseded-runtime-decision",
    query: "Bun 런타임에 대한 최신 결정은?",
    fullContext: [
      noise("runtime-before"),
      "Earlier idea: remove Bun and move everything to Node.",
      "Final runtime decision: Butler-managed Bun is the current decision.",
      "The old remove Bun idea is superseded and must not be reported as current.",
      noise("runtime-after"),
    ].join("\n"),
    compactContext: [
      "Compaction summary:",
      "Final runtime decision is Butler-managed Bun.",
      "The remove Bun plan is superseded, not current.",
    ].join("\n"),
    requiredFacts: [
      {
        id: "managed-bun-current",
        description: "Butler-managed Bun is the current decision",
        evidenceTerms: ["Butler-managed Bun", "Final runtime decision"],
        answerTerms: ["Butler-managed Bun", "current decision"],
      },
      {
        id: "remove-bun-superseded",
        description: "remove Bun is superseded",
        evidenceTerms: ["remove Bun", "superseded"],
        answerTerms: ["remove Bun", "superseded"],
      },
    ],
    forbiddenFacts: [{
      id: "remove-bun-current",
      description: "remove Bun is current",
      evidenceTerms: ["remove Bun", "current"],
      answerTerms: ["remove Bun is current"],
    }],
  },
  {
    id: "background-worker-topic-switch",
    query: "A 작업이 끝났을 때 B 대화 맥락과 어떻게 보고해야 하나?",
    fullContext: [
      noise("worker-before"),
      "Topic A: worker A is an architecture investigation and must report structure, runtime, transport, routing, memory, tests.",
      "Topic B: web search provider quality discussion is active while worker A continued in background.",
      "When worker A completes, report A naturally while preserving B context.",
      noise("worker-after"),
    ].join("\n"),
    compactContext: [
      "Compaction summary:",
      "Open work A: architecture investigation worker must report structure, runtime, transport, routing, memory, tests.",
      "Current conversation B: web search provider quality discussion is active.",
      "Reporting rule: when A completes, report A naturally while preserving B context.",
    ].join("\n"),
    requiredFacts: [
      {
        id: "worker-a-scope",
        description: "worker A is an architecture investigation",
        evidenceTerms: ["worker", "architecture investigation"],
        answerTerms: ["worker A", "architecture investigation"],
      },
      {
        id: "topic-b-active",
        description: "topic B remains web search provider quality",
        evidenceTerms: ["web search provider quality", "active"],
        answerTerms: ["web search provider quality", "active"],
      },
      {
        id: "natural-a-report-preserve-b",
        description: "report A naturally while preserving B context",
        evidenceTerms: ["report A naturally", "preserving B context"],
        answerTerms: ["report A naturally", "preserving B context"],
      },
    ],
  },
];

test("compact context preserves answer quality against full-context baseline", () => {
  const results = fixtures.map(evaluateQualityTradeoff);
  const summary = summarizeQualityTradeoffs(results);

  expect(summary.fixtureCount).toBe(3);
  expect(summary.averageTokenReductionRatio).toBeGreaterThan(0.90);
  expect(summary.averageQualityRetentionRatio).toBe(1);
  expect(summary.minimumQualityRetentionRatio).toBe(1);
  expect(summary.totalForbiddenHits).toBe(0);

  for (const result of results) {
    expect(result.fullQuality.requiredCoverage).toBe(1);
    expect(result.compactQuality.requiredCoverage).toBe(1);
    expect(result.compactQuality.forbiddenHits).toEqual([]);
    expect(result.compactTokens).toBeLessThan(result.fullTokens);
  }
});

test("quality retention gate catches lossy compaction", () => {
  const lossy = evaluateQualityTradeoff({
    ...fixtures[0],
    compactContext: "Compaction summary: user mentioned food.",
  });

  expect(lossy.fullQuality.score).toBe(1);
  expect(lossy.compactQuality.score).toBeLessThan(1);
  expect(lossy.qualityRetentionRatio).toBeLessThan(1);
});

test("quality retention adversarial fixtures preserve corrections and avoid partial-evidence hallucination", () => {
  const conflictFixture: QualityFixture = {
    id: "conflicting-preference-correction",
    query: "현재 선호하는 작업 보고 방식은?",
    fullContext: [
      noise("report-before", 20),
      "Older preference: send long detailed reports after every worker event.",
      "Correction: current preference is concise progress then reviewed completion only.",
      "The older long detailed report preference is superseded.",
      noise("report-after", 20),
    ].join("\n"),
    compactContext: [
      "Compaction summary:",
      "Current preference: concise progress then reviewed completion only.",
      "Superseded preference: long detailed reports after every worker event.",
    ].join("\n"),
    requiredFacts: [
      {
        id: "concise-current",
        description: "concise progress then reviewed completion is current",
        evidenceTerms: ["concise progress", "reviewed completion", "current preference"],
        answerTerms: ["concise progress", "reviewed completion"],
      },
      {
        id: "long-report-superseded",
        description: "long detailed event reports are superseded",
        evidenceTerms: ["long detailed reports", "superseded"],
        answerTerms: ["long detailed", "superseded"],
      },
    ],
    forbiddenFacts: [{
      id: "long-report-current",
      description: "long detailed reports are current",
      evidenceTerms: ["long detailed reports", "current"],
      answerTerms: ["long detailed reports are current"],
    }],
  };

  const result = evaluateQualityTradeoff(conflictFixture);
  expect(result.compactQuality.requiredCoverage).toBe(1);
  expect(result.compactQuality.forbiddenHits).toEqual([]);

  const partialAnswer = synthesizeEvidenceAnswer("Compaction summary: concise progress only.", conflictFixture);
  expect(partialAnswer).not.toContain("long-report-superseded");
  expect(partialAnswer).not.toContain("long detailed reports are current");
});

test("optional model-judged quality interface is injected and not required for deterministic gates", async () => {
  const fixture = fixtures[0];
  const unavailable = await evaluateOptionalModelJudgedQuality({ fixture });
  expect(unavailable).toEqual({
    available: false,
    reason: "judge_not_configured",
  });

  const judged = await evaluateOptionalModelJudgedQuality({
    fixture,
    judge: async ({ deterministic }) => ({
      score: deterministic.qualityRetentionRatio,
      rationale: "Injected judge agrees with deterministic retention.",
      risks: [],
    }),
  });

  expect(judged).toMatchObject({
    available: true,
    score: 1,
    rationale: "Injected judge agrees with deterministic retention.",
    deterministic: {
      qualityRetentionRatio: 1,
    },
  });
});
