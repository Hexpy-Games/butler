import { describe, expect, test } from "bun:test";
import {
  BTCC_REVISION_BENCHMARK_CORPUS,
  BTCC_REVISION_BENCHMARK_SCHEMA,
  calculateObservationMetrics,
  createBenchmarkPlan,
  createEmptyBenchmarkEvidence,
  evaluateBenchmarkEvidence,
  type BenchmarkTarget,
  type BtccRevision,
  type RawBenchmarkObservation,
} from "../support/btcc-revision-benchmark/index.ts";

describe("minimal BTCC revision paired benchmark", () => {
  test("materializes two identical paired prompts in each tier and enforces target isolation", () => {
    const plan = createBenchmarkPlan({
      runId: "smoke-1",
      createdAt: "2026-07-30T12:00:00.000Z",
      targets: targets(),
      fixtures: {
        WEATHER_DATE: "2026-07-30",
        EXISTING_FOLDER_PATH: "/tmp/btcc-fixture",
        MARKET_DATE: "2026-07-30",
        WORK_REPORT_PATH: "artifacts/market.md",
        SAUSAGE_REPORT_PATH: "artifacts/sausage.md",
      },
    });

    expect(BTCC_REVISION_BENCHMARK_CORPUS).toHaveLength(8);
    for (const tier of ["direct", "simple_tool", "work_ledger", "project_ledger"] as const) {
      expect(plan.prompts.filter((prompt) => prompt.tier === tier)).toHaveLength(2);
    }
    expect(plan.prompts.every((prompt) => !prompt.prompt.includes("{{"))).toBe(true);
    expect(plan.prompts.map((prompt) => prompt.order)).toEqual([
      ["r2", "r3"], ["r3", "r2"], ["r2", "r3"], ["r3", "r2"],
      ["r2", "r3"], ["r3", "r2"], ["r2", "r3"], ["r3", "r2"],
    ]);

    const notIsolated = targets();
    notIsolated.r3.dataRoot = notIsolated.r2.dataRoot;
    expect(() => createBenchmarkPlan({
      runId: "bad",
      createdAt: "2026-07-30T12:00:00.000Z",
      targets: notIsolated,
      fixtures: {},
    })).toThrow("isolate dataRoot");
  });

  test("keeps a new run empty and derives product-facing metrics from one raw observation", () => {
    const plan = createBenchmarkPlan({
      runId: "empty-run",
      createdAt: "2026-07-30T12:00:00.000Z",
      targets: targets(),
      fixtures: {
        WEATHER_DATE: "2026-07-30",
        EXISTING_FOLDER_PATH: "/tmp/btcc-fixture",
        MARKET_DATE: "2026-07-30",
        WORK_REPORT_PATH: "artifacts/market.md",
        SAUSAGE_REPORT_PATH: "artifacts/sausage.md",
      },
    });
    const empty = createEmptyBenchmarkEvidence(plan);
    expect(empty.observations).toEqual([]);
    expect(evaluateBenchmarkEvidence(empty)).toMatchObject({
      verdict: "insufficient_evidence",
      expectedObservations: 16,
      observedObservations: 0,
      reasons: ["observations_incomplete"],
    });

    const metrics = calculateObservationMetrics(observation(plan.targets.r3));
    expect(metrics).toMatchObject({
      measurementComplete: true,
      outcomeSuccess: true,
      qualityScore: 4,
      acknowledgementMs: 10,
      contextPreparationMs: 20,
      providerFirstTokenMs: 50,
      firstMeaningfulMs: 80,
      productWallMs: 200,
      unrecoveredToolErrors: 0,
      durabilityPass: true,
      safetyPass: true,
    });
  });
});

function targets(): Record<BtccRevision, BenchmarkTarget> {
  return {
    r2: target("r2", 28765),
    r3: target("r3", 28766),
  };
}

function target(revision: BtccRevision, port: number): BenchmarkTarget {
  return {
    revision,
    worktreePath: `/tmp/btcc-${revision}`,
    commit: revision === "r2" ? "1".repeat(40) : "2".repeat(40),
    buildId: `build-${revision}`,
    appBaseUrl: `http://127.0.0.1:${port}`,
    electronDebugPort: port + 1_000,
    dataRoot: `/tmp/btcc-${revision}/data`,
    electronUserData: `/tmp/btcc-${revision}/electron`,
    workspaceRoot: `/tmp/btcc-${revision}/workspace`,
    model: "openai/test-model",
    reasoningEffort: "low",
    permissionMode: "full_access",
    fixtureHash: "fixture-v1",
  };
}

function observation(targetValue: BenchmarkTarget): RawBenchmarkObservation {
  return {
    schema: BTCC_REVISION_BENCHMARK_SCHEMA,
    kind: "raw_product_observation",
    runId: "metric-only-test",
    promptId: "direct_greeting",
    revision: targetValue.revision,
    prompt: "안녕하세요. 오늘도 잘 부탁해요.",
    target: targetValue,
    turnId: "turn-1",
    terminalState: "delivered",
    finalText: "안녕하세요! 오늘도 잘 부탁드립니다.",
    providerReportedModel: targetValue.model,
    quality: {
      intentScore: 4,
      resultScore: 4,
      requiredOutcomes: { natural_greeting: true },
      assessmentNote: "unit-test fixture",
    },
    usage: {
      modelRequests: 1,
      promptTokens: 100,
      cachedPromptTokens: 0,
      outputTokens: 20,
      totalTokens: 120,
      serializedContextBytes: 2_000,
    },
    timing: {
      submittedAtMs: 0,
      acknowledgedAtMs: 10,
      admittedAtMs: 20,
      modelRequestStartedAtMs: 40,
      firstProviderTokenAtMs: 90,
      firstMeaningfulAtMs: 80,
      finalVisibleAtMs: 180,
      terminalAtMs: 200,
      maxSilentGapMs: 70,
    },
    ux: { progressMessages: [], protocolJargonMessages: 0, userInterventions: 0 },
    loop: { noProgressTurns: 0, validatorRejections: 0 },
    tools: { calls: 0, failedCalls: 0, recoveredErrors: 0, recoveryTimeMs: 0 },
    durability: {
      finalMessagesBeforeReload: 1,
      finalMessagesAfterReload: 1,
      eventReplayParity: true,
      continuationTested: false,
      continuationSucceeded: null,
    },
    safety: {
      unauthorizedEffects: 0,
      targetEscapes: 0,
      falseSuccessClaims: 0,
      privacyLeaks: 0,
    },
    artifactRefs: [],
  };
}
