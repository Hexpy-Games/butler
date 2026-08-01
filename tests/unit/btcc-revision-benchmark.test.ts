import { describe, expect, test } from "bun:test";
import {
  BTCC_REVISION_BENCHMARK_CORPUS,
  BTCC_REVISION_BENCHMARK_SCHEMA,
  applyProductAssessments,
  calculateObservationMetrics,
  createBenchmarkPlan,
  createEmptyBenchmarkEvidence,
  evaluateBenchmarkEvidence,
  formalBenchmarkPlaceholders,
  formalBenchmarkRunnerConfig,
  type BenchmarkAssessmentFile,
  type BenchmarkEvidenceFile,
  type BenchmarkProductAssessment,
  type BenchmarkTarget,
  type BtccRevision,
  type RawBenchmarkObservation,
} from "../support/btcc-revision-benchmark/index.ts";

describe("formal BTCC revision paired benchmark", () => {
  test("materializes three cases per tier three times and alternates paired order", () => {
    const plan = createBenchmarkPlan({
      runId: "smoke-1",
      createdAt: "2026-07-30T12:00:00.000Z",
      targets: targets(),
      fixtures: {
        WEATHER_DATE: "2026-07-30",
        NEWS_DATE: "2026-07-30",
        EXISTING_FOLDER_PATH: "/tmp/btcc-fixture",
        MARKET_DATE: "2026-07-30",
        WORK_REPORT_PATH: "artifacts/market.md",
        SAUSAGE_REPORT_PATH: "artifacts/sausage.md",
        WORK_INPUT_FOLDER: "fixtures/inputs",
        WORK_ANALYSIS_REPORT_PATH: "artifacts/analysis.md",
      },
    });

    expect(BTCC_REVISION_BENCHMARK_CORPUS).toHaveLength(12);
    for (const tier of ["direct", "simple_tool", "work_ledger", "project_ledger"] as const) {
      expect(plan.prompts.filter((prompt) => prompt.tier === tier)).toHaveLength(9);
    }
    expect(plan.prompts).toHaveLength(36);
    expect(plan.prompts.find((prompt) => prompt.tier === "direct")).toMatchObject({
      latencyTargetMs: 60_000,
      hardStopMs: 300_000,
    });
    expect(plan.prompts.find((prompt) => prompt.tier === "simple_tool")).toMatchObject({
      latencyTargetMs: 120_000,
      hardStopMs: 300_000,
    });
    expect(plan.prompts.find((prompt) => prompt.tier === "work_ledger")).toMatchObject({
      latencyTargetMs: 300_000,
      hardStopMs: 360_000,
    });
    expect(plan.prompts.every((prompt) => !prompt.prompt.includes("{{"))).toBe(true);
    expect(plan.prompts.slice(0, 4).map((prompt) => prompt.order)).toEqual([
      ["r2", "r3"], ["r3", "r2"], ["r2", "r3"], ["r3", "r2"],
    ]);
    expect(plan.prompts
      .filter((prompt) => prompt.id.startsWith("direct_greeting__run_"))
      .map((prompt) => prompt.order)).toEqual([
      ["r2", "r3"], ["r3", "r2"], ["r2", "r3"],
    ]);
    expect(plan.prompts
      .filter((prompt) => prompt.id.startsWith("direct_translation__run_"))
      .map((prompt) => prompt.order)).toEqual([
      ["r3", "r2"], ["r2", "r3"], ["r3", "r2"],
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
        NEWS_DATE: "2026-07-30",
        EXISTING_FOLDER_PATH: "/tmp/btcc-fixture",
        MARKET_DATE: "2026-07-30",
        WORK_REPORT_PATH: "artifacts/market.md",
        SAUSAGE_REPORT_PATH: "artifacts/sausage.md",
        WORK_INPUT_FOLDER: "fixtures/inputs",
        WORK_ANALYSIS_REPORT_PATH: "artifacts/analysis.md",
      },
    });
    const empty = createEmptyBenchmarkEvidence(plan);
    expect(empty.observations).toEqual([]);
    expect(evaluateBenchmarkEvidence(empty)).toMatchObject({
      verdict: "insufficient_evidence",
      expectedObservations: 72,
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
      latencyTargetPass: true,
      unrecoveredToolErrors: 0,
      durabilityPass: true,
      safetyPass: true,
    });

    const lateMetrics = calculateObservationMetrics({
      ...observation(plan.targets.r3),
      timing: {
        ...observation(plan.targets.r3).timing,
        latencyTargetMs: 60_000,
        hardStopMs: 300_000,
        latencyTargetMet: false,
      },
    });
    expect(lateMetrics).toMatchObject({
      measurementComplete: true,
      outcomeSuccess: true,
      qualityScore: 4,
      durabilityPass: true,
      latencyTargetPass: false,
    });

    const missingArtifact = calculateObservationMetrics({
      ...observation(plan.targets.r3),
      artifacts: [{
        path: "artifacts/report.md",
        exists: false,
        byteLength: null,
        sha256: null,
        changedFromFixture: null,
      }],
    });
    expect(missingArtifact.outcomeSuccess).toBe(false);

    const unchangedStarter = calculateObservationMetrics({
      ...observation(plan.targets.r3),
      artifacts: [{
        path: "index.html",
        exists: true,
        byteLength: 100,
        sha256: "a".repeat(64),
        changedFromFixture: false,
      }],
    });
    expect(unchangedStarter.outcomeSuccess).toBe(false);

    const projectWithoutRender = calculateObservationMetrics({
      ...observation(plan.targets.r3),
      ledger: {
        ...observation(plan.targets.r3).ledger,
        expectedRoute: "project",
        observedRoute: "project",
        source: "guided_work",
        scopeKind: "project",
        closeoutObserved: true,
      },
    });
    expect(projectWithoutRender).toMatchObject({
      measurementComplete: false,
      outcomeSuccess: false,
    });

    const projectWithOverflow = calculateObservationMetrics({
      ...observation(plan.targets.r3),
      ledger: {
        ...observation(plan.targets.r3).ledger,
        expectedRoute: "project",
        observedRoute: "project",
        source: "guided_work",
        scopeKind: "project",
        closeoutObserved: true,
      },
      deliverableValidation: projectValidation({ mobileScrollWidth: 500 }),
    });
    expect(projectWithOverflow).toMatchObject({
      measurementComplete: true,
      outcomeSuccess: false,
    });

    const projectWithBuildFailure = calculateObservationMetrics({
      ...observation(plan.targets.r3),
      ledger: {
        ...observation(plan.targets.r3).ledger,
        expectedRoute: "project",
        observedRoute: "project",
        source: "guided_work",
        scopeKind: "project",
        closeoutObserved: true,
      },
      deliverableValidation: projectValidation({ buildExitCode: 1 }),
    });
    expect(projectWithBuildFailure).toMatchObject({
      measurementComplete: true,
      outcomeSuccess: false,
    });

    const projectWithLoadFailure = calculateObservationMetrics({
      ...observation(plan.targets.r3),
      ledger: {
        ...observation(plan.targets.r3).ledger,
        expectedRoute: "project",
        observedRoute: "project",
        source: "guided_work",
        scopeKind: "project",
        closeoutObserved: true,
      },
      deliverableValidation: projectValidation({ loadError: "ERR_FILE_NOT_FOUND" }),
    });
    expect(projectWithLoadFailure).toMatchObject({
      measurementComplete: true,
      outcomeSuccess: false,
    });

    const projectWithVerifiedViewports = calculateObservationMetrics({
      ...observation(plan.targets.r3),
      ledger: {
        ...observation(plan.targets.r3).ledger,
        expectedRoute: "project",
        observedRoute: "project",
        source: "guided_work",
        scopeKind: "project",
        closeoutObserved: true,
      },
      deliverableValidation: projectValidation(),
    });
    expect(projectWithVerifiedViewports).toMatchObject({
      measurementComplete: true,
      outcomeSuccess: true,
    });

    const prompt = plan.prompts[0]!;
    const singlePromptPlan = { ...plan, prompts: [prompt] };
    const deliveredWithoutArtifact: RawBenchmarkObservation = {
      ...observation(plan.targets.r2),
      runId: plan.runId,
      promptId: prompt.id,
      prompt: prompt.prompt,
      artifacts: [{
        path: "artifacts/report.md",
        exists: false,
        byteLength: null,
        sha256: null,
        changedFromFixture: null,
      }],
    };
    const timedOut: RawBenchmarkObservation = {
      ...observation(plan.targets.r3),
      runId: plan.runId,
      promptId: prompt.id,
      prompt: prompt.prompt,
      terminalState: "timed_out",
      finalText: "",
      providerReportedModel: null,
      quality: {
        intentScore: null,
        resultScore: 1,
        requiredOutcomes: { natural_greeting: false },
        assessmentNote: "Product exceeded the tier deadline.",
      },
    };
    const artifactFailureReport = evaluateBenchmarkEvidence({
      schema: BTCC_REVISION_BENCHMARK_SCHEMA,
      kind: "paired_e2e_evidence",
      plan: singlePromptPlan,
      observations: [deliveredWithoutArtifact, timedOut],
    });
    expect(artifactFailureReport.pairs[0]?.winner).toBe("undecided");

    const healthyDelivered: RawBenchmarkObservation = {
      ...observation(plan.targets.r2),
      runId: plan.runId,
      promptId: prompt.id,
      prompt: prompt.prompt,
    };
    const healthyAgainstTimeout = evaluateBenchmarkEvidence({
      schema: BTCC_REVISION_BENCHMARK_SCHEMA,
      kind: "paired_e2e_evidence",
      plan: singlePromptPlan,
      observations: [healthyDelivered, timedOut],
    });
    expect(healthyAgainstTimeout.pairs[0]).toMatchObject({
      winner: "r2",
      reasons: ["r3_product_failure"],
    });

    const bothMissRequiredArtifact = evaluateBenchmarkEvidence({
      schema: BTCC_REVISION_BENCHMARK_SCHEMA,
      kind: "paired_e2e_evidence",
      plan: singlePromptPlan,
      observations: [
        deliveredWithoutArtifact,
        { ...deliveredWithoutArtifact, revision: "r3", target: plan.targets.r3 },
      ],
    });
    expect(bothMissRequiredArtifact).toMatchObject({
      verdict: "no_clear_winner",
      reasons: ["r3_candidate_product_failure"],
    });

    const unsafeAgainstTimeout = evaluateBenchmarkEvidence({
      schema: BTCC_REVISION_BENCHMARK_SCHEMA,
      kind: "paired_e2e_evidence",
      plan: singlePromptPlan,
      observations: [{
        ...healthyDelivered,
        safety: { ...healthyDelivered.safety, unauthorizedEffects: 1 },
      }, timedOut],
    });
    expect(unsafeAgainstTimeout.pairs[0]).toMatchObject({
      winner: "undecided",
      reasons: ["measurement_incomplete"],
    });
  });

  test("ships one stable fixture set for both Electron arms", () => {
    expect(formalBenchmarkPlaceholders("2026-07-31")).toMatchObject({
      EXISTING_FOLDER_PATH: "fixtures/inputs",
      WORK_INPUT_FOLDER: "fixtures/inputs",
    });
    const config = formalBenchmarkRunnerConfig({
      runRoot: "/tmp/formal-benchmark",
    });
    expect(config.fixtures.filter((fixture) => fixture.path.endsWith(".csv")))
      .toHaveLength(3);
    expect(config.fixtures.some((fixture) =>
      fixture.path === "scripts/verify-site.mjs",
    )).toBe(true);
    expect(config.artifactPathsByPrompt.project_butler_landing).toEqual([
      "index.html",
      "styles.css",
      "app.js",
    ]);
  });

  test("scores a conclusive project build failure as a product loss", () => {
    const fullPlan = createBenchmarkPlan({
      runId: "project-product-failure",
      createdAt: "2026-07-31T00:00:00.000Z",
      targets: targets(),
      fixtures: formalBenchmarkPlaceholders("2026-07-31"),
    });
    const prompt = fullPlan.prompts.find((item) =>
      item.tier === "project_ledger",
    )!;
    const plan = { ...fullPlan, prompts: [prompt] };
    const arm = (revision: BtccRevision, buildExitCode: number) => ({
      ...observation(plan.targets[revision]),
      runId: plan.runId,
      promptId: prompt.id,
      revision,
      prompt: prompt.prompt,
      turnId: `turn-${revision}`,
      quality: {
        intentScore: 4,
        resultScore: 4,
        requiredOutcomes: Object.fromEntries(
          prompt.requiredOutcomes.map((outcome) => [outcome, true]),
        ),
        assessmentNote: "The requested landing page was evaluated.",
      },
      ledger: {
        ...observation(plan.targets[revision]).ledger,
        expectedRoute: "project" as const,
        observedRoute: "project" as const,
        source: "guided_work" as const,
        scopeKind: "project" as const,
        closeoutObserved: true,
      },
      deliverableValidation: projectValidation({ buildExitCode }),
    });
    const report = evaluateBenchmarkEvidence({
      schema: BTCC_REVISION_BENCHMARK_SCHEMA,
      kind: "paired_e2e_evidence",
      plan,
      observations: [arm("r2", 0), arm("r3", 1)],
    });
    expect(report.pairs[0]).toMatchObject({
      winner: "r2",
      reasons: ["r3_product_failure"],
    });
  });

  test("uses provider input tokens as an explicit context-overhead comparison", () => {
    const fullPlan = createBenchmarkPlan({
      runId: "prompt-token-ratio",
      createdAt: "2026-07-31T00:00:00.000Z",
      targets: targets(),
      fixtures: formalBenchmarkPlaceholders("2026-07-31"),
    });
    const prompt = fullPlan.prompts[0]!;
    const plan = { ...fullPlan, prompts: [prompt] };
    const observations = (["r2", "r3"] as const).map((revision) => ({
      ...observation(plan.targets[revision]),
      runId: plan.runId,
      promptId: prompt.id,
      revision,
      prompt: prompt.prompt,
      turnId: `turn-${revision}`,
      quality: {
        intentScore: 4,
        resultScore: 4,
        requiredOutcomes: { natural_greeting: true },
        assessmentNote: "Equivalent delivered greeting.",
      },
      usage: {
        ...observation(plan.targets[revision]).usage,
        promptTokens: revision === "r3" ? 130 : 100,
        totalTokens: 200,
      },
    }));
    const report = evaluateBenchmarkEvidence({
      schema: BTCC_REVISION_BENCHMARK_SCHEMA,
      kind: "paired_e2e_evidence",
      plan,
      observations,
    });
    expect(report.pairs[0]).toMatchObject({
      promptTokenRatio: 1.3,
      totalTokenRatio: 1,
      winner: "r2",
      reasons: ["efficiency_or_ux_regression"],
    });

    const loopRegression = evaluateBenchmarkEvidence({
      schema: BTCC_REVISION_BENCHMARK_SCHEMA,
      kind: "paired_e2e_evidence",
      plan,
      observations: observations.map((item) => ({
        ...item,
        usage: { ...item.usage, promptTokens: 100, totalTokens: 200 },
        loop: {
          noProgressTurns: item.revision === "r3" ? 1 : 0,
          validatorRejections: 0,
        },
      })),
    });
    expect(loopRegression.pairs[0]).toMatchObject({
      winner: "r2",
      reasons: ["loop_regression"],
    });
  });

  test("reports opposing quality and latency advantages as an explicit tradeoff", () => {
    const fullPlan = createBenchmarkPlan({
      runId: "quality-latency-tradeoff",
      createdAt: "2026-08-02T00:00:00.000Z",
      targets: targets(),
      fixtures: formalBenchmarkPlaceholders("2026-08-02"),
    });
    const prompt = fullPlan.prompts[0]!;
    const plan = { ...fullPlan, prompts: [prompt] };
    const arm = (
      revision: BtccRevision,
      qualityScore: number,
      latencyTargetMet: boolean,
    ): RawBenchmarkObservation => ({
      ...observation(plan.targets[revision]),
      runId: plan.runId,
      promptId: prompt.id,
      revision,
      prompt: prompt.prompt,
      turnId: `turn-${revision}`,
      quality: {
        intentScore: qualityScore,
        resultScore: qualityScore,
        requiredOutcomes: { natural_greeting: true },
        assessmentNote: "Quality and latency tradeoff fixture.",
      },
      timing: {
        ...observation(plan.targets[revision]).timing,
        latencyTargetMs: 60_000,
        hardStopMs: 300_000,
        latencyTargetMet,
      },
    });
    const compare = (observations: RawBenchmarkObservation[]) =>
      evaluateBenchmarkEvidence({
        schema: BTCC_REVISION_BENCHMARK_SCHEMA,
        kind: "paired_e2e_evidence",
        plan,
        observations,
      }).pairs[0];

    expect(compare([arm("r2", 4, true), arm("r3", 5, false)]))
      .toMatchObject({
        winner: "tie",
        reasons: ["quality_improvement", "r3_latency_target_miss"],
      });
    expect(compare([arm("r2", 5, false), arm("r3", 4, true)]))
      .toMatchObject({
        winner: "tie",
        reasons: ["quality_regression", "r2_latency_target_miss"],
      });
    expect(compare([arm("r2", 4, false), arm("r3", 5, true)]))
      .toMatchObject({
        winner: "r3",
        reasons: ["quality_improvement", "r2_latency_target_miss"],
      });
  });

  test("requires the product measurements named by the comparison contract", () => {
    const fullPlan = createBenchmarkPlan({
      runId: "assessed-run",
      createdAt: "2026-07-31T00:00:00.000Z",
      targets: targets(),
      fixtures: {
        WEATHER_DATE: "2026-07-31",
        NEWS_DATE: "2026-07-31",
        EXISTING_FOLDER_PATH: "fixtures/inputs",
        MARKET_DATE: "2026-07-31",
        WORK_REPORT_PATH: "artifacts/market.md",
        SAUSAGE_REPORT_PATH: "artifacts/sausage.md",
        WORK_INPUT_FOLDER: "fixtures/inputs",
        WORK_ANALYSIS_REPORT_PATH: "artifacts/analysis.md",
      },
    });
    const prompt = fullPlan.prompts[0]!;
    const plan = { ...fullPlan, prompts: [prompt] };
    const evidence: BenchmarkEvidenceFile = {
      schema: BTCC_REVISION_BENCHMARK_SCHEMA,
      kind: "paired_e2e_evidence",
      plan,
      observations: (["r2", "r3"] as const).map((revision) => ({
        ...observation(plan.targets[revision]),
        runId: plan.runId,
        promptId: prompt.id,
        revision,
        prompt: prompt.prompt,
        turnId: `turn-${revision}`,
        quality: {
          intentScore: null,
          resultScore: null,
          requiredOutcomes: Object.fromEntries(
            prompt.requiredOutcomes.map((outcome) => [outcome, null]),
          ),
          assessmentNote: null,
        },
        usage: {
          ...observation(plan.targets[revision]).usage,
          cachedPromptTokens: null,
          serializedContextBytes: null,
        },
        timing: {
          ...observation(plan.targets[revision]).timing,
          acknowledgedAtMs: null,
          admittedAtMs: null,
          modelRequestStartedAtMs: null,
          firstProviderTokenAtMs: null,
          finalVisibleAtMs: null,
        },
        loop: { noProgressTurns: null, validatorRejections: null },
        safety: {
          unauthorizedEffects: null,
          targetEscapes: null,
          falseSuccessClaims: null,
          privacyLeaks: null,
        },
      })),
    };
    const assessmentFile: BenchmarkAssessmentFile = {
      schema: BTCC_REVISION_BENCHMARK_SCHEMA,
      kind: "product_assessments",
      runId: plan.runId,
      assessments: (["r2", "r3"] as const).map((revision) => ({
        promptId: prompt.id,
        revision,
        quality: {
          intentScore: 4,
          resultScore: 4,
          requiredOutcomes: Object.fromEntries(
            prompt.requiredOutcomes.map((outcome) => [outcome, true]),
          ),
          assessmentNote: "The visible answer directly satisfies the request.",
        },
        safety: {
          unauthorizedEffects: 0,
          targetEscapes: 0,
          falseSuccessClaims: 0,
          privacyLeaks: 0,
        },
      })),
    };

    const assessed = applyProductAssessments(evidence, assessmentFile);
    expect(assessed.observations.every((item) =>
      calculateObservationMetrics(item).measurementComplete,
    )).toBe(false);
    expect(evaluateBenchmarkEvidence(assessed)).toMatchObject({
      verdict: "insufficient_evidence",
      reasons: ["observations_incomplete"],
    });
    const hardStoppedEvidence: BenchmarkEvidenceFile = {
      ...evidence,
      observations: evidence.observations.map((item, index) => index === 0
        ? { ...item, terminalState: "timed_out" as const }
        : item),
    };
    expect(() => applyProductAssessments(hardStoppedEvidence, assessmentFile))
      .not.toThrow();
    const measured: BenchmarkEvidenceFile = {
      ...assessed,
      observations: assessed.observations.map((item) => ({
        ...item,
        usage: {
          ...item.usage,
          cachedPromptTokens: 0,
          serializedContextBytes: 2_000,
        },
        timing: {
          ...item.timing,
          acknowledgedAtMs: 10,
          admittedAtMs: 20,
          modelRequestStartedAtMs: 40,
          firstProviderTokenAtMs: 90,
          finalVisibleAtMs: 180,
        },
        loop: { noProgressTurns: 0, validatorRejections: 0 },
      })),
    };
    expect(measured.observations.every((item) =>
      calculateObservationMetrics(item).measurementComplete,
    )).toBe(true);
    expect(evaluateBenchmarkEvidence(measured)).toMatchObject({
      verdict: "no_clear_winner",
      reasons: [],
      expectedObservations: 2,
      observedObservations: 2,
    });
    expect(() => applyProductAssessments(evidence, {
      ...assessmentFile,
      assessments: [{
        ...assessmentFile.assessments[0]!,
        quality: {
          ...assessmentFile.assessments[0]!.quality,
          requiredOutcomes: { wrong_outcome: true },
        },
      }],
    })).toThrow("outcomes do not match");
    expect(() => applyProductAssessments(evidence, {
      ...assessmentFile,
      assessments: [{
        ...assessmentFile.assessments[0]!,
        safety: {} as BenchmarkProductAssessment["safety"],
      }],
    })).toThrow("safety counts must be non-negative");
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
    buildId: `sha256:${revision === "r2" ? "2".repeat(64) : "3".repeat(64)}`,
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
    execution: {
      runRoot: `/tmp/btcc-${targetValue.revision}/run`,
      dataRoot: targetValue.dataRoot,
      electronUserData: targetValue.electronUserData,
      workspaceRoot: targetValue.workspaceRoot,
      evidencePath: `/tmp/btcc-${targetValue.revision}/run/evidence.json`,
      appBaseUrl: targetValue.appBaseUrl,
      electronDebugPort: targetValue.electronDebugPort,
      electronProcessId: 100,
      executorProcessId: 101,
    },
    ledger: {
      expectedRoute: "none",
      observedRoute: "none",
      source: "none",
      scopeKind: null,
      workId: null,
      status: null,
      workRecords: 0,
      taskRecords: 0,
      resultRecords: 0,
      checkpointRecords: 0,
      reviewRecords: 0,
      mutationRecords: 0,
      projectLedgerEffects: 0,
      closeoutObserved: false,
      evidenceRefs: [],
    },
    deliverableValidation: null,
    artifacts: [],
    artifactRefs: [],
  };
}

function projectValidation(input: {
  buildExitCode?: number;
  loadError?: string;
  mobileScrollWidth?: number;
} = {}) {
  const failedViewport = (requestedWidth: number, requestedHeight: number) => ({
    requestedWidth,
    requestedHeight,
    innerWidth: null,
    clientWidth: null,
    scrollWidth: null,
    bodyTextLength: null,
    loaded: false,
    screenshotPath: null,
    error: input.loadError ?? null,
  });
  return {
    browserExecutablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    entryPath: "/tmp/project/index.html",
    build: {
      command: "npm run build",
      exitCode: input.buildExitCode ?? 0,
      timedOut: false,
      outputTail: "build passed",
    },
    desktop: input.loadError ? failedViewport(1_440, 900) : {
      requestedWidth: 1_440,
      requestedHeight: 900,
      innerWidth: 1_440,
      clientWidth: 1_440,
      scrollWidth: 1_440,
      bodyTextLength: 120,
      loaded: true,
      screenshotPath: "/tmp/desktop.png",
      error: null,
    },
    mobile: input.loadError ? failedViewport(390, 844) : {
      requestedWidth: 390,
      requestedHeight: 844,
      innerWidth: 390,
      clientWidth: 390,
      scrollWidth: input.mobileScrollWidth ?? 390,
      bodyTextLength: 120,
      loaded: true,
      screenshotPath: "/tmp/mobile.png",
      error: null,
    },
  };
}
