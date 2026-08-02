import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BTCC_REVISION_BENCHMARK_SCHEMA,
  createBenchmarkPlan,
  createEmptyBenchmarkEvidence,
  runBenchmarkPairs,
  type BenchmarkRunnerConfig,
  type BenchmarkTarget,
  type BtccRevision,
  type RawBenchmarkObservation,
} from "../support/btcc-revision-benchmark/index.ts";
import type { ProductObservationInput } from
  "../support/btcc-revision-benchmark/product-observation.ts";
import { prepareBenchmarkBundledAgentResource } from
  "../support/btcc-revision-benchmark/bundled-agent-resource-cache.ts";

describe("BTCC revision Electron benchmark runner", () => {
  test("runs all 72 observations sequentially in paired order and persists timeouts", async () => {
    const evidence = createEmptyBenchmarkEvidence(plan());
    const calls: Array<{
      bundledAgentResourceDir: string | undefined;
      harnessWorkExpectation: boolean;
      promptId: string;
      revision: string;
      timeoutMs: number | undefined;
    }> = [];
    let persisted = 0;
    let projectValidations = 0;
    let sharedAgentPreparations = 0;
    const result = await runBenchmarkPairs({
      config: runnerConfig(),
      evidence,
      dependencies: {
        verifyTargets: () => undefined,
        prepareSharedAgentResource: () => {
          sharedAgentPreparations += 1;
          return "/tmp/btcc-formal-run/shared-r3-agent";
        },
        runHarness: async (scenario, options) => {
          const promptId = scenario.steps[0]!.id;
          const revision = options.repoRoot?.endsWith("-r2") ? "r2" : "r3";
          calls.push({
            bundledAgentResourceDir: options.bundledAgentResourceDir,
            harnessWorkExpectation:
              scenario.steps[0]?.expect?.work !== undefined,
            promptId,
            revision,
            timeoutMs: scenario.steps[0]?.timeoutMs,
          });
          if (promptId === "work_market_research__run_1" && revision === "r2") {
            throw new Error(
              "Timed out waiting for Electron Turn after 360000 ms.\nEvidence: fixture",
            );
          }
          return { run: {}, observations: [{}] };
        },
        collectObservation: (input) => fakeObservation(input),
        validateProjectDeliverable: async () => {
          projectValidations += 1;
          return projectValidation({
            buildExitCode: projectValidations === 1 ? 1 : 0,
          });
        },
        persist: () => {
          persisted += 1;
        },
      },
    });

    expect(result.observations).toHaveLength(72);
    expect(sharedAgentPreparations).toBe(1);
    expect(persisted).toBe(72);
    expect(projectValidations).toBe(18);
    expect(calls.slice(0, 4).map(({ promptId, revision }) => [
      promptId,
      revision,
    ])).toEqual([
      ["direct_greeting__run_1", "r2"],
      ["direct_greeting__run_1", "r3"],
      ["direct_translation__run_1", "r3"],
      ["direct_translation__run_1", "r2"],
    ]);
    expect(calls.find((call) =>
      call.promptId === "work_market_research__run_1",
    )?.harnessWorkExpectation).toBe(false);
    expect(calls.every((call) => !call.harnessWorkExpectation)).toBe(true);
    expect(calls.find((call) => call.promptId === "direct_greeting__run_1")?.timeoutMs)
      .toBe(300_000);
    expect(calls.find((call) => call.promptId === "work_market_research__run_1")?.timeoutMs)
      .toBe(360_000);
    expect(calls.filter((call) => call.revision === "r3").every((call) =>
      call.bundledAgentResourceDir === "/tmp/btcc-formal-run/shared-r3-agent",
    )).toBe(true);
    expect(calls.filter((call) => call.revision === "r2").every((call) =>
      call.bundledAgentResourceDir === undefined,
    )).toBe(true);
    expect(result.observations.find((observation) =>
      observation.promptId === "work_market_research__run_1" &&
      observation.revision === "r2",
    )?.terminalState).toBe("timed_out");
    expect(result.observations.filter((observation) =>
      observation.deliverableValidation !== null,
    )).toHaveLength(18);
    expect(result.observations.some((observation) =>
      observation.deliverableValidation?.build.exitCode === 1,
    )).toBe(true);
  });

  test("resumes without rerunning an already recorded arm", async () => {
    const evidence = createEmptyBenchmarkEvidence(plan());
    const firstPrompt = evidence.plan.prompts[0]!;
    evidence.observations.push(fakeObservation({
      artifactPaths: [],
      evidence: {},
      fixtures: [],
      prompt: firstPrompt,
      revision: firstPrompt.order[0],
      runId: evidence.plan.runId,
      runRoot: "/tmp/already-recorded",
      target: evidence.plan.targets[firstPrompt.order[0]],
      timedOut: false,
    }));
    let calls = 0;
    await runBenchmarkPairs({
      config: runnerConfig(),
      evidence,
      dependencies: {
        verifyTargets: () => undefined,
        prepareSharedAgentResource: () => "/tmp/btcc-formal-run/shared-r3-agent",
        runHarness: async () => {
          calls += 1;
          return { run: {}, observations: [{}] };
        },
        collectObservation: (input) => fakeObservation(input),
        validateProjectDeliverable: async () => projectValidation(),
      },
    });
    expect(calls).toBe(71);
    expect(evidence.observations).toHaveLength(72);
  });

  test("reuses one complete bundled Agent resource for the same R3 commit and build", () => {
    const runRoot = mkdtempSync(join(tmpdir(), "btcc-agent-resource-cache-"));
    let preparations = 0;
    try {
      const prepare = (_repoRoot: string, workDir: string) => {
        preparations += 1;
        const resourceDir = join(workDir, "darwin-arm64", "bundled-agent");
        mkdirSync(join(resourceDir, "runtime"), { recursive: true });
        writeFileSync(join(resourceDir, "agent-release-manifest.json"), "{}\n");
        writeFileSync(join(resourceDir, "agent-update-manifest.json"), "{}\n");
        return { resourceDir };
      };
      const input = { runRoot, target: target("r3") };
      const first = prepareBenchmarkBundledAgentResource(input, prepare);
      const second = prepareBenchmarkBundledAgentResource(input, prepare);

      expect(second).toBe(first);
      expect(preparations).toBe(1);
    } finally {
      rmSync(runRoot, { recursive: true, force: true });
    }
  });
});

function plan() {
  return createBenchmarkPlan({
    runId: "formal-run",
    createdAt: "2026-07-31T00:00:00.000Z",
    targets: {
      r2: target("r2"),
      r3: target("r3"),
    },
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
}

function projectValidation(input: { buildExitCode?: number } = {}) {
  return {
    browserExecutablePath: "/test/chrome",
    entryPath: "/test/workspace/index.html",
    build: {
      command: "npm run build",
      exitCode: input.buildExitCode ?? 0,
      timedOut: false,
      outputTail: "test build",
    },
    desktop: {
      requestedWidth: 1_440,
      requestedHeight: 900,
      innerWidth: 1_440,
      clientWidth: 1_440,
      scrollWidth: 1_440,
      bodyTextLength: 100,
      loaded: true,
      screenshotPath: "/test/desktop.png",
      error: null,
    },
    mobile: {
      requestedWidth: 390,
      requestedHeight: 844,
      innerWidth: 390,
      clientWidth: 390,
      scrollWidth: 390,
      bodyTextLength: 100,
      loaded: true,
      screenshotPath: "/test/mobile.png",
      error: null,
    },
  };
}

function target(revision: BtccRevision): BenchmarkTarget {
  return {
    revision,
    worktreePath: `/tmp/butler-${revision}`,
    commit: revision.repeat(40),
    buildId: `sha256:${revision === "r2" ? "2".repeat(64) : "3".repeat(64)}`,
    appBaseUrl: `http://127.0.0.1:${revision === "r2" ? 28765 : 28766}`,
    electronDebugPort: revision === "r2" ? 29765 : 29766,
    dataRoot: `/tmp/butler-${revision}/data`,
    electronUserData: `/tmp/butler-${revision}/electron`,
    workspaceRoot: `/tmp/butler-${revision}/workspace`,
    model: "openai/gpt-5.6-sol",
    reasoningEffort: "low",
    permissionMode: "full_access",
    fixtureHash: "fixture-v1",
  };
}

function runnerConfig(): BenchmarkRunnerConfig {
  return {
    runRoot: "/tmp/btcc-formal-run",
    fixtures: [{
      path: "fixtures/inputs/january.csv",
      text: "month,total\n2026-01,100\n",
    }],
    artifactPathsByPrompt: {
      work_market_research: ["artifacts/market.md"],
      work_sausage_research: ["artifacts/sausage.md"],
      work_fixture_analysis: ["artifacts/analysis.md"],
      project_butler_landing: ["index.html"],
      project_sandy_landing: ["index.html"],
      project_product_dashboard: ["index.html"],
    },
  };
}

function fakeObservation(input: ProductObservationInput): RawBenchmarkObservation {
  const delivered = !input.timedOut;
  const observedRoute = input.prompt.expectedLedgerRoute;
  return {
    schema: BTCC_REVISION_BENCHMARK_SCHEMA,
    kind: "raw_product_observation",
    runId: input.runId,
    promptId: input.prompt.id,
    revision: input.revision,
    prompt: input.prompt.prompt,
    target: input.target,
    turnId: `turn-${input.prompt.id}-${input.revision}`,
    terminalState: delivered ? "delivered" : "timed_out",
    finalText: delivered ? "done" : "",
    providerReportedModel: input.target.model,
    quality: {
      intentScore: delivered ? 4 : 1,
      resultScore: delivered ? 4 : 1,
      requiredOutcomes: Object.fromEntries(input.prompt.requiredOutcomes.map((key) => [
        key,
        delivered,
      ])),
      assessmentNote: "runner test",
    },
    usage: {
      modelRequests: 1,
      promptTokens: 10,
      cachedPromptTokens: 0,
      outputTokens: 2,
      totalTokens: 12,
      serializedContextBytes: 100,
    },
    timing: {
      submittedAtMs: 0,
      acknowledgedAtMs: 1,
      admittedAtMs: 1,
      modelRequestStartedAtMs: 2,
      firstProviderTokenAtMs: 3,
      firstMeaningfulAtMs: 4,
      finalVisibleAtMs: delivered ? 5 : null,
      terminalAtMs: 5,
      maxSilentGapMs: 2,
    },
    ux: { progressMessages: [], protocolJargonMessages: 0, userInterventions: 0 },
    loop: { noProgressTurns: 0, validatorRejections: 0 },
    tools: { calls: 0, failedCalls: 0, recoveredErrors: 0, recoveryTimeMs: 0 },
    durability: {
      finalMessagesBeforeReload: delivered ? 1 : 0,
      finalMessagesAfterReload: delivered ? 1 : 0,
      eventReplayParity: delivered,
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
      runRoot: input.runRoot,
      dataRoot: `${input.runRoot}/data`,
      electronUserData: `${input.runRoot}/electron`,
      workspaceRoot: `${input.runRoot}/workspace`,
      evidencePath: `${input.runRoot}/evidence.json`,
      appBaseUrl: input.target.appBaseUrl,
      electronDebugPort: input.target.electronDebugPort,
      electronProcessId: 100,
      executorProcessId: 101,
    },
    ledger: {
      expectedRoute: input.prompt.expectedLedgerRoute,
      observedRoute,
      source: observedRoute === "none" ? "none" : "guided_work",
      scopeKind: observedRoute === "project"
        ? "project"
        : observedRoute === "work" ? "session" : null,
      workId: observedRoute === "none" ? null : "work-1",
      status: observedRoute === "none" ? null : "completed",
      workRecords: observedRoute === "none" ? 0 : 1,
      taskRecords: 0,
      resultRecords: observedRoute === "none" ? 0 : 1,
      checkpointRecords: observedRoute === "none" ? 0 : 1,
      reviewRecords: observedRoute === "none" ? 0 : 1,
      mutationRecords: observedRoute === "none" ? 0 : 1,
      projectLedgerEffects: observedRoute === "project" ? 1 : 0,
      closeoutObserved: observedRoute !== "none",
      evidenceRefs: [],
    },
    deliverableValidation: input.deliverableValidation ?? null,
    artifacts: input.artifactPaths.map((path) => ({
      path,
      exists: true,
      byteLength: 10,
      sha256: "a".repeat(64),
      changedFromFixture: true,
    })),
    artifactRefs: input.artifactPaths,
  };
}
