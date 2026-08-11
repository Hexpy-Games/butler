import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runM1V2BaselineCampaign } from
  "../support/m1-v2-baseline/runner.ts";
import type { M1V2RepetitionResult } from
  "../support/m1-v2-baseline/contracts.ts";
import type { ElectronScenario } from "../e2e/btcc-r3-electron/contracts.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

test("product failures remain rejected and do not truncate the fixed campaign", async () => {
  const outputRoot = temporaryRoot();
  let calls = 0;
  const result = await runM1V2BaselineCampaign({
    outputRoot,
    repetitions: 3,
    repoRoot: process.cwd(),
    sourceData: "/source-data",
    sourceRevision: "a".repeat(40),
  }, {
    runHarness: async (scenario, options) => {
      calls += 1;
      writeFailureEvidence(options.runRoot!, scenario.id, scenario.steps.at(-1)!.id, 500);
      throw new Error("provider product failure");
    },
    readMetrics: () => [],
    readDb: () => dbEvidence(),
    assess: (input) => rejected(input.armId, input.repetition ?? 0),
    validateLanding: async () => null,
  });
  expect(calls).toBe(12);
  expect(result.counts).toEqual({ accepted: 0, rejected: 12, gated: 0 });
  expect(result.repetitions).toHaveLength(12);
});

test("auth failure is an explicit gate and stops without fabricating remaining runs", async () => {
  const outputRoot = temporaryRoot();
  let calls = 0;
  const result = await runM1V2BaselineCampaign({
    outputRoot,
    repetitions: 3,
    repoRoot: process.cwd(),
    sourceData: "/source-data",
    sourceRevision: "a".repeat(40),
  }, {
    runHarness: async (scenario, options) => {
      calls += 1;
      writeFailureEvidence(options.runRoot!, scenario.id, scenario.steps.at(-1)!.id, 401);
      throw new Error("provider auth failure");
    },
  });
  expect(calls).toBe(1);
  expect(result.counts).toEqual({ accepted: 0, rejected: 0, gated: 1 });
  expect(result.repetitions[0]?.reasons).toEqual(["provider_auth_gate"]);
  expect(result.complete).toBe(false);
});

test("assessment defects escape instead of being mislabeled as infrastructure", async () => {
  const outputRoot = temporaryRoot();
  await expect(runM1V2BaselineCampaign({
    outputRoot,
    repetitions: 3,
    repoRoot: process.cwd(),
    sourceData: "/source-data",
    sourceRevision: "a".repeat(40),
  }, {
    runHarness: async (scenario, options) => successEvidence(scenario, options.runRoot!),
    readMetrics: () => [],
    readDb: () => dbEvidence(),
    assess: () => {
      throw new Error("assessment bug");
    },
  })).rejects.toThrow("assessment bug");
});

test("refuses an existing output root before any evidence can be reused", async () => {
  const outputRoot = temporaryRoot();
  mkdirSync(outputRoot);
  let calls = 0;
  await expect(runM1V2BaselineCampaign({
    outputRoot,
    repetitions: 3,
    repoRoot: process.cwd(),
    sourceData: "/source-data",
    sourceRevision: "a".repeat(40),
  }, {
    runHarness: async () => {
      calls += 1;
      return {};
    },
  })).rejects.toThrow();
  expect(calls).toBe(0);
});

test("preflight failure cannot promote stale success evidence with another run identity", async () => {
  const outputRoot = temporaryRoot();
  const result = await runM1V2BaselineCampaign({
    outputRoot,
    repetitions: 3,
    repoRoot: process.cwd(),
    sourceData: "/source-data",
    sourceRevision: "a".repeat(40),
  }, {
    runHarness: async (scenario, options) => {
      mkdirSync(options.runRoot!, { recursive: true });
      writeFileSync(join(options.runRoot!, "evidence.json"), JSON.stringify({
        ...successEvidence(scenario, options.runRoot!),
        run: {
          ...(successEvidence(scenario, options.runRoot!).run as Record<string, unknown>),
          runId: "stale-success-from-another-run",
        },
      }));
      throw new Error("preflight failed");
    },
  });
  expect(result.counts).toEqual({ accepted: 0, rejected: 0, gated: 1 });
  expect(result.repetitions[0]?.reasons).toEqual(["evidence_identity_mismatch"]);
});

function temporaryRoot(): string {
  const parent = mkdtempSync(join(tmpdir(), "m1-v2-runner-failure-"));
  roots.push(parent);
  return join(parent, "output");
}

function writeFailureEvidence(
  runRoot: string,
  scenarioId: string,
  stepId: string,
  status: number,
): void {
  mkdirSync(join(runRoot, "data"), { recursive: true });
  writeFileSync(join(runRoot, "evidence.json"), JSON.stringify({
    ok: false,
    generatedAt: new Date().toISOString(),
    run: {
      dataRoot: join(runRoot, "data"),
      runRoot,
      workspaceRoot: join(runRoot, "workspace"),
      runId: `${scenarioId}-${Date.now()}-test`,
    },
    launches: [{ electronPid: 1 }],
    observations: [{ stepId, terminalState: "failed" }],
    providerRequests: [{ status, termination: "failed" }],
  }));
}

function successEvidence(
  scenario: ElectronScenario,
  runRoot: string,
): Record<string, unknown> {
  const step = scenario.steps.at(-1)!;
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    run: {
      dataRoot: join(runRoot, "data"),
      runRoot,
      workspaceRoot: join(runRoot, "workspace"),
      runId: `${scenario.id}-${Date.now()}-test`,
      model: "openai/gpt-5.6-sol",
      reasoningEffort: "medium",
    },
    session: { id: scenario.id },
    observations: [{
      stepId: step.id,
      promptSha256: createHash("sha256").update(step.prompt).digest("hex"),
      turnId: `turn-${step.id}`,
      terminalState: "delivered",
      timing: { submittedAtMs: 1, terminalAtMs: 2 },
    }],
  };
}

function dbEvidence() {
  return {
    quickCheckDatabases: 1,
    quickCheckPassed: true,
    toolCalls: 0,
    webToolCalls: 0,
    pagePreviewToolCalls: 0,
    buildCommandToolCalls: 0,
    fileMutationToolCalls: 0,
    duplicateAppliedEffects: 0,
    unresolvedCorrections: 0,
    lostRequiredAnchors: 0,
  };
}

function rejected(
  armId: M1V2RepetitionResult["armId"],
  repetition: number,
): M1V2RepetitionResult {
  return {
    armId,
    repetition,
    status: "rejected",
    reasons: ["product_failure"],
    targetTerminalState: "failed",
    agentAttempts: [],
    auxiliaryPhysicalAttempts: 0,
    titlePhysicalAttempts: 0,
    providerToolPhysicalAttempts: 0,
    unarmedPhysicalOverhead: {
      auxiliary: { attempts: 0, providerSendBytes: 0 },
      title: { attempts: 0, providerSendBytes: 0 },
      toolProvider: { attempts: 0, providerSendBytes: 0 },
    },
    otherShare: null,
    reducibleShare: null,
    semanticRounds: 0,
    toolCalls: 0,
    elapsedMs: null,
    firstUsefulMs: null,
    reloadPassed: false,
    quality: {
      conciseGreeting: null,
      fixedDatePresent: null,
      umbrellaRecommendationPresent: null,
      sourceReferenceCount: null,
      sourceGrounded: null,
      landing: null,
    },
    db: dbEvidence(),
    work: {
      observed: false,
      status: null,
      planRevision: null,
      checkpointStage: null,
      checkpointStages: 0,
      planReviewVerdict: null,
      resultReviewVerdict: null,
      completionValidationVerdict: null,
      resultToolNames: 0,
      projectLedgerWorkRecords: 0,
      projectLedgerCompletedWorkRecords: 0,
      projectLedgerCloseoutObserved: false,
      duplicateEvidenceCount: null,
      lostCorrectionEvidenceCount: null,
      lostRequiredAnchorCount: null,
      workspaceAuthorityPassed: null,
      providerRoutingPassed: null,
      stallObserved: null,
    },
  };
}
