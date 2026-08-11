import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runM1V2BaselineCampaign } from
  "../support/m1-v2-baseline/runner.ts";
import type { M1V2RepetitionResult } from
  "../support/m1-v2-baseline/contracts.ts";

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
  }, {
    runHarness: async (scenario, options) => {
      calls += 1;
      writeFailureEvidence(options.runRoot!, scenario.steps.at(-1)!.id, 500);
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
  }, {
    runHarness: async (scenario, options) => {
      calls += 1;
      writeFailureEvidence(options.runRoot!, scenario.steps.at(-1)!.id, 401);
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
  }, {
    runHarness: async (scenario, options) => successEvidence(
      scenario.steps.at(-1)!.id,
      options.runRoot!,
    ),
    readMetrics: () => [],
    readDb: () => dbEvidence(),
    assess: () => {
      throw new Error("assessment bug");
    },
  })).rejects.toThrow("assessment bug");
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "m1-v2-runner-failure-"));
  roots.push(root);
  return root;
}

function writeFailureEvidence(runRoot: string, stepId: string, status: number): void {
  mkdirSync(join(runRoot, "data"), { recursive: true });
  writeFileSync(join(runRoot, "evidence.json"), JSON.stringify({
    ok: false,
    run: {
      dataRoot: join(runRoot, "data"),
      runRoot,
      workspaceRoot: join(runRoot, "workspace"),
    },
    launches: [{ electronPid: 1 }],
    observations: [{ stepId, terminalState: "failed" }],
    providerRequests: [{ status, termination: "failed" }],
  }));
}

function successEvidence(stepId: string, runRoot: string): Record<string, unknown> {
  return {
    ok: true,
    run: {
      dataRoot: join(runRoot, "data"),
      runRoot,
      workspaceRoot: join(runRoot, "workspace"),
    },
    observations: [{
      stepId,
      turnId: `turn-${stepId}`,
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
      stallObserved: null,
    },
  };
}
