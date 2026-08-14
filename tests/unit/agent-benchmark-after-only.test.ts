import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgentBenchmarkCli } from "../support/agent-benchmark/cli.ts";
import { createBenchmarkPlan } from "../support/agent-benchmark/planning.ts";
import { createGatedBenchmarkObservation, redactBenchmarkPlan, redactBenchmarkResult,
  resumeOrInitialize } from "../support/agent-benchmark/checkpoint.ts";
import { createPairedCampaignContract, FINAL_ACTIVATION, FINAL_AFTER_REVISION,
  FINAL_BEFORE_REVISION, FINAL_EXECUTION } from "../support/agent-benchmark/paired-contract.ts";
import { AFTER_ONLY_AFTER_REVISION, AFTER_ONLY_BASE_REVISION } from "../support/agent-benchmark/after-only-contract.ts";
import { hashBenchmarkFixture, loadM1V2BenchmarkFixtures } from "../support/agent-benchmark/fixtures.ts";
import { summarizeBenchmarkResult } from "../support/agent-benchmark/report.ts";
import type { AgentAdapter, BenchmarkObservation, BenchmarkResultFile } from "../support/agent-benchmark/contracts.ts";
import type { CommandExecutor } from "../support/agent-benchmark/command.ts";
import { prepareTestHarnessAuthority } from "./support/m1-v2-provenance-authority.ts";

const root = mkdtempSync(join(process.cwd(), ".agent-benchmark-after-only-"));
const authority = prepareTestHarnessAuthority(root);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("M1 v2 AFTER-only public entrypoint", () => {
  test("imports exact frozen BEFORE comparison cells and executes only 12 canonical AFTER arms", async () => {
    const frozen = writeFrozenBefore();
    const afterRoot = join(root, "after-source");
    execFileSync("git", ["clone", "--quiet", "--no-checkout", process.cwd(), afterRoot]);
    execFileSync("git", ["-C", afterRoot, "checkout", "--quiet", AFTER_ONLY_AFTER_REVISION]);
    const resource = join(root, "after-resource"); mkdirSync(resource);
    const resourcePin = join(root, "after-pin.json");
    writeFileSync(resourcePin, JSON.stringify({ resourceDir: resource, ...pin(AFTER_ONLY_AFTER_REVISION, "8") }));
    const runRoot = join(root, "after-run");
    let entries = 0;
    const butler: AgentAdapter = { agent: "butler",
      async preflight() { return available(); },
      async run(input) {
        entries += 1;
        expect(input.arm.version).toBe("after");
        expect(input.arm.sourceRevision).toBe(AFTER_ONLY_AFTER_REVISION);
        expect(input.arm.activation).toEqual(FINAL_ACTIVATION.after);
        return { exitCode: 0, gateCode: "none", timedOut: false, cancelled: false, stdout: "", stderr: "",
          adapterVersion: "fake", provider: "openai", finalText: "provider-free", sessionId: null,
          effectiveConfig: { model: "openai/gpt-5.6-sol" }, usage: {}, tools: {}, timing: {}, operations: {},
          changedPaths: [], evidenceRefs: [], providerDispatchState: "provider_output_observed",
          pairedExecutionEvidence: { provider: "openai", model: "openai/gpt-5.6-sol", reasoning: "medium",
            providerServiceTiers: ["default"], requestServiceTiers: ["auto_by_omission"],
            requestModels: ["openai/gpt-5.6-sol"], requestReasoning: ["medium"],
            authorizationSchemes: ["bearer"], routeIds: ["openai-codex-responses"] } };
      } };
    const never = (agent: "hermes" | "opencode"): AgentAdapter => ({ agent,
      async preflight() { throw new Error("not scheduled"); }, async run() { throw new Error("not scheduled"); } });
    const args = afterOnlyArgs(runRoot, afterRoot, resourcePin, frozen);
    await runAgentBenchmarkCli(args, {
      createAdapters: () => ({ butler, hermes: never("hermes"), opencode: never("opencode") }),
      preflightExecutor: authExecutor(),
      landingValidator: async () => ({ buildPassed: null, testPassed: null, browserAvailable: false,
        desktop: { loaded: false, overflowFree: false, screenshotRef: null },
        mobile: { loaded: false, overflowFree: false, screenshotRef: null }, visualQuality: null, diagnostics: [] }),
    });
    expect(entries).toBe(12);
    const persisted = readFileSync(join(runRoot, "manifest.json"), "utf8");
    const manifest = JSON.parse(persisted) as import("../support/agent-benchmark/contracts.ts").BenchmarkPlan;
    expect(manifest.arms).toHaveLength(12);
    expect(manifest.arms.every((arm) => arm.version === "after")).toBe(true);
    expect(manifest.afterOnlyCampaign?.after).toMatchObject({ baseRevision: AFTER_ONLY_BASE_REVISION,
      revision: AFTER_ONLY_AFTER_REVISION, activation: { mode: "on" } });
    expect(manifest.afterOnlyCampaign?.frozenBefore.cells.filter((cell) => cell.comparison)).toHaveLength(8);
    const reportSummary = JSON.parse(readFileSync(join(runRoot, "report", "agent-benchmark-summary.json"), "utf8")) as {
      pairedCampaign: { rows: Array<{ version: string }> };
    };
    expect(reportSummary.pairedCampaign.rows.filter((row) => row.version === "before")).toHaveLength(8);
    expect(manifest.afterOnlyCampaign?.frozenBefore.cells.filter((cell) => !cell.comparison)
      .map((cell) => `${cell.fixture}:${cell.repetition}:${cell.gateCode}`)).toEqual([
        "landing-cold:1:measurement_unavailable", "current-web-cold:2:measurement_unavailable",
        "landing-cold:2:measurement_unavailable", "landing-cold:3:measurement_unavailable",
      ]);
    expect(persisted).not.toContain("private-before-source");
    expect(persisted).not.toContain("private-evidence-ref");
    expect(persisted).not.toContain("raw frozen diagnostic");
    const checkpointPath = join(runRoot, "result.json");
    const computedSummary = summarizeBenchmarkResult(JSON.parse(readFileSync(checkpointPath, "utf8")) as BenchmarkResultFile);
    expect(computedSummary.pairedCampaign?.rows).toHaveLength(8);
    expect(computedSummary.pairedCampaign?.aggregate.decisions).toHaveLength(0);
    expect(computedSummary.pairedCampaign?.acceptance.complete).toBe(false);
    const replaceable = JSON.parse(readFileSync(checkpointPath, "utf8")) as BenchmarkResultFile;
    expect(replaceable.plan.repositoryEvidence?.relativeRoot).toBe("evidence/repository-after");
    replaceable.observations = [createGatedBenchmarkObservation(replaceable.plan.arms[0]!, {
      available: false, executable: null, version: null, authenticated: null, configVerified: false,
      gateCode: "measurement_unavailable", diagnostic: "pre-adapter infrastructure unavailable",
    })];
    writeFileSync(checkpointPath, JSON.stringify(replaceable));
    const entriesBeforeReplacement = entries;
    await runAgentBenchmarkCli(args, { createAdapters: () => ({ butler, hermes: never("hermes"), opencode: never("opencode") }),
      preflightExecutor: authExecutor() });
    expect(entries).toBe(entriesBeforeReplacement + 12);
    const replaced = JSON.parse(readFileSync(checkpointPath, "utf8")) as BenchmarkResultFile;
    expect(replaced.replacements).toHaveLength(1);
    expect(replaced.replacements?.[0]?.reason).toBe("pre_provider_infrastructure_replacement");
    const reordered = JSON.parse(readFileSync(checkpointPath, "utf8")) as BenchmarkResultFile;
    [reordered.observations[0], reordered.observations[1]] = [reordered.observations[1]!, reordered.observations[0]!];
    writeFileSync(checkpointPath, JSON.stringify(reordered));
    const entriesBeforeResume = entries;
    await expect(runAgentBenchmarkCli(args, { createAdapters: () => ({ butler, hermes: never("hermes"), opencode: never("opencode") }),
      preflightExecutor: authExecutor() })).rejects.toThrow("observation identity/order mismatch");
    expect(entries).toBe(entriesBeforeResume);
  }, 30_000);

  test("fails hash, accepted-set, and activation tamper before adapter entry", async () => {
    const frozen = writeFrozenBefore();
    await expect(runAgentBenchmarkCli(afterOnlyArgs(join(root, "hash-tamper-run"), join(root, "absent-after"),
      writeResourcePin(), { ...frozen, manifestSha256: "0".repeat(64) }), { preflightExecutor: authExecutor(), createAdapters: () => { throw new Error("adapter entered"); } }))
      .rejects.toThrow("Frozen BEFORE manifest/result hash mismatch");

    const acceptedTamper = mutateFrozen(frozen, (_manifest, result) => {
      const before = result.observations;
      const accepted = before.find((row) => row.arm.scenario === "direct-cold" && row.arm.repetition === 1)!;
      const unavailable = before.find((row) => row.arm.scenario === "current-web-cold" && row.arm.repetition === 2)!;
      accepted.terminalState = "gated"; accepted.gateCode = "measurement_unavailable"; accepted.pairedComparableIdentity = null; accepted.m1V2 = null;
      unavailable.terminalState = "accepted"; unavailable.gateCode = "none";
      unavailable.pairedComparableIdentity = frozenObservation(unavailable.arm, true).pairedComparableIdentity;
      unavailable.m1V2 = frozenObservation(unavailable.arm, true).m1V2;
      unavailable.evaluation.accepted = true;
    });
    await expect(runAgentBenchmarkCli(afterOnlyArgs(join(root, "set-tamper-run"), join(root, "absent-after"),
      writeResourcePin(), acceptedTamper), { preflightExecutor: authExecutor(), createAdapters: () => { throw new Error("adapter entered"); } }))
      .rejects.toThrow("AFTER-only campaign contract identity mismatch");

    const activationTamper = mutateFrozen(frozen, (manifest, result) => {
      const arm = manifest.arms.find((row) => row.version === "before")!;
      arm.activation = FINAL_ACTIVATION.after;
      result.plan = structuredClone(manifest);
      result.observations.find((row) => row.arm.key === arm.key)!.arm.activation = FINAL_ACTIVATION.after;
    });
    await expect(runAgentBenchmarkCli(afterOnlyArgs(join(root, "activation-tamper-run"), join(root, "absent-after"),
      writeResourcePin(), activationTamper), { preflightExecutor: authExecutor(), createAdapters: () => { throw new Error("adapter entered"); } }))
      .rejects.toThrow("Frozen BEFORE manifest semantic identity mismatch");

    const semanticTamper = mutateFrozen(frozen, (manifest, result) => {
      manifest.baselineSha = "b".repeat(40);
      result.plan = structuredClone(manifest);
      result.run.baselineSha = manifest.baselineSha;
    });
    await expect(runAgentBenchmarkCli(afterOnlyArgs(join(root, "semantic-tamper-run"), join(root, "absent-after"),
      writeResourcePin(), semanticTamper), { preflightExecutor: authExecutor(), createAdapters: () => { throw new Error("adapter entered"); } }))
      .rejects.toThrow("Frozen BEFORE manifest semantic identity mismatch");

    const durableTamper = mutateFrozen(frozen, (_manifest, result) => {
      result.observations.find((row) => row.terminalState === "accepted")!
        .m1V2!.durableEvidence!.identity.turnId = "forged-turn";
    });
    await expect(runAgentBenchmarkCli(afterOnlyArgs(join(root, "durable-tamper-run"), join(root, "absent-after"),
      writeResourcePin(), durableTamper), { preflightExecutor: authExecutor(), createAdapters: () => { throw new Error("adapter entered"); } }))
      .rejects.toThrow("Frozen BEFORE durable evidence semantic identity mismatch");
  });
});

function writeFrozenBefore() {
  const hashes = fixtureHashes();
  const contract = createPairedCampaignContract({
    before: sourcePin("before", FINAL_BEFORE_REVISION, "1"), after: sourcePin("after", FINAL_AFTER_REVISION, "2"),
    execution: FINAL_EXECUTION, authReceipt: authReceipt(), fixtureHashes: hashes, provenance: provenance(),
  });
  const plan = createBenchmarkPlan({ campaign: "m1-v2-paired", runId: "frozen-before", seed: 1,
    runRoot: join(root, "frozen-run"), sourceRoot: join(root, "private-after-source"),
    harnessRoot: authority.harnessRoot, provenanceJsonlPath: authority.jsonlPath,
    baselineSha: FINAL_AFTER_REVISION, controlledModel: "openai/gpt-5.6-sol", controlledReasoning: "medium",
    pairedCampaign: contract, pairedRuntimeSources: { before: join(root, "private-before-source"), after: join(root, "private-after-source") } });
  const result = resumeOrInitialize(plan, null);
  const accepted = new Set(["direct-cold:1", "direct-warm:1", "current-web-cold:1",
    "direct-cold:2", "direct-warm:2", "direct-cold:3", "direct-warm:3", "current-web-cold:3"]);
  result.observations = plan.arms.filter((arm) => arm.version === "before").map((arm) =>
    frozenObservation(arm, accepted.has(`${arm.scenario}:${arm.repetition}`)));
  const manifestPath = join(root, `frozen-manifest-${crypto.randomUUID()}.json`);
  const resultPath = join(root, `frozen-result-${crypto.randomUUID()}.json`);
  writeFileSync(manifestPath, JSON.stringify(redactBenchmarkPlan(plan)));
  writeFileSync(resultPath, JSON.stringify(redactBenchmarkResult(result)));
  return { manifestPath, resultPath, manifestSha256: fileSha(manifestPath), resultSha256: fileSha(resultPath) };
}

function mutateFrozen(frozen: ReturnType<typeof writeFrozenBefore>, mutate: (manifest: import("../support/agent-benchmark/contracts.ts").BenchmarkPlan,
  result: BenchmarkResultFile) => void) {
  const manifest = JSON.parse(readFileSync(frozen.manifestPath, "utf8"));
  const result = JSON.parse(readFileSync(frozen.resultPath, "utf8"));
  mutate(manifest, result);
  const manifestPath = join(root, `tampered-manifest-${crypto.randomUUID()}.json`);
  const resultPath = join(root, `tampered-result-${crypto.randomUUID()}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest)); writeFileSync(resultPath, JSON.stringify(result));
  return { manifestPath, resultPath, manifestSha256: fileSha(manifestPath), resultSha256: fileSha(resultPath) };
}

function frozenObservation(arm: import("../support/agent-benchmark/contracts.ts").BenchmarkArmPlan, accepted: boolean): BenchmarkObservation {
  const base = { schema: "butler.agent-benchmark.v1" as const, kind: "agent_benchmark_observation" as const, arm,
    terminalState: accepted ? "accepted" as const : "gated" as const, gateCode: accepted ? "none" as const : "measurement_unavailable" as const,
    adapterVersion: null, effectiveConfig: arm.effectiveConfig, usage: { inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, totalTokens: null, modelRequests: null },
    tools: { calls: null, failedCalls: null, records: [] }, timing: { submittedAtMs: null, firstUsefulOutputAtMs: null, terminalAtMs: null, totalElapsedMs: null },
    operations: { userInterventions: null, retries: null, changedFiles: null, tests: { ran: null, passed: null, command: null }, build: { ran: null, passed: null, command: null } },
    evaluation: { accepted: accepted ? true : null, factualAccuracy: null, sourceQuality: null, visualQuality: null, resultQuality: null, evaluatorNotes: [], evidenceRefs: [] },
    visualReview: null, privacy: { redacted: true, promptLeak: false, credentialLeak: false, rawToolPayloadLeak: false, privatePathLeak: false, hiddenReasoningLeak: false },
    acceptedResultPerToken: null, promptHash: null, answerHash: null, changedPaths: [], diagnostics: ["raw frozen diagnostic"], evidenceRefs: ["private-evidence-ref"],
    providerDispatchState: accepted ? "provider_output_observed" as const : "not_dispatched" as const, infrastructureGateStage: null };
  if (!accepted) return { ...base, pairedComparableIdentity: null, m1V2: null };
  const identity = { fixture: `${arm.scenario}:${arm.fixtureHash}`, sourceRevision: FINAL_BEFORE_REVISION,
    model: "openai/gpt-5.6-sol", reasoning: "medium", executionMode: "ordinary_non_fast", provider: "openai",
    providerTransport: "openai-codex", authMode: "managed", cache: "eligible:cache-v1",
    route: "openai-codex-responses", retryOrdinal: 0, usageAvailability: "unavailable" as const };
  const attempt = { providerSendBytes: 100, promptTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
    outputTokens: null, reasoningTokens: null, totalTokens: null, segments: {} };
  const targetEvidenceIdentity = { sessionId: `session-${arm.order}`, turnId: `turn-${arm.order}` };
  const durableIdentity = { planIdentity: arm.planIdentity!, sourceRevision: arm.sourceRevision, fixtureHash: arm.fixtureHash,
    armKey: arm.key, armId: arm.scenario, repetition: arm.repetition, block: arm.block!, stepId: "target-step",
    version: "before", pairId: arm.pairId!, armOrder: arm.order, ...targetEvidenceIdentity,
    expectedProviderId: "openai-codex", expectedModelRef: "openai/gpt-5.6-sol", expectedRouteId: "openai-codex-responses",
    expectedCacheBoundaryRevision: "cache-v1", membershipSha256: "9".repeat(64) };
  return { ...base, pairedComparableIdentity: identity, m1V2: { armId: arm.scenario, agentAttempts: [attempt],
    unarmedPhysicalOverhead: {}, auxiliaryPhysicalAttempts: 0, titlePhysicalAttempts: 0, providerToolPhysicalAttempts: 0,
    semanticRounds: 1, toolCalls: 0, elapsedMs: 100, firstUsefulMs: 10, status: "accepted", db: { quickCheckPassed: true,
      duplicateAppliedEffects: 0, unresolvedCorrections: 0, lostRequiredAnchors: 0 }, reloadPassed: true,
    targetEvidenceIdentity, durableEvidence: { handle: "evidence/sc01-public-evidence.json", sha256: "8".repeat(64), identity: durableIdentity } } } as unknown as BenchmarkObservation;
}

function afterOnlyArgs(runRoot: string, afterRoot: string, resourcePin: string, frozen: ReturnType<typeof writeFrozenBefore>) {
  return ["run", "--campaign", "m1-v2-after-only", "--seed", "20260814", "--run-id", "after-only",
    "--run-root", runRoot, "--harness-root", authority.harnessRoot, "--provenance-jsonl", authority.jsonlPath,
    "--controlled-model", "openai/gpt-5.6-sol", "--controlled-reasoning", "medium", "--source-revision", AFTER_ONLY_AFTER_REVISION,
    "--repetitions", "3", "--after-source-root", afterRoot, "--after-prepared-butler-resource-pin", resourcePin,
    "--frozen-before-manifest", frozen.manifestPath, "--frozen-before-result", frozen.resultPath,
    "--frozen-before-manifest-sha256", frozen.manifestSha256, "--frozen-before-result-sha256", frozen.resultSha256];
}
function writeResourcePin() { const dir = join(root, `resource-${crypto.randomUUID()}`); mkdirSync(dir); const path = `${dir}.json`;
  writeFileSync(path, JSON.stringify({ resourceDir: dir, ...pin(AFTER_ONLY_AFTER_REVISION, "8") })); return path; }
function fixtureHashes() { return Object.fromEntries(loadM1V2BenchmarkFixtures(authority.harnessRoot).map((fixture) => [fixture.id, hashBenchmarkFixture(fixture)])) as never; }
function provenance() { return createBenchmarkPlan({ campaign: "m1-v2", runId: `p-${crypto.randomUUID()}`, seed: 1,
  runRoot: join(root, `p-${crypto.randomUUID()}`), sourceRoot: process.cwd(), harnessRoot: authority.harnessRoot,
  provenanceJsonlPath: authority.jsonlPath, baselineSha: "a".repeat(40), controlledModel: "openai/gpt-5.6-sol" }).provenance!; }
function pin(revision: string, fill: string) { return { sourceRevision: revision, sourceCompatibilitySha256: fill.repeat(64), manifestSha256: "3".repeat(64), dependencyClosureSha256: "4".repeat(64), resourceSha256: fill.repeat(64), resourceBytes: 10, archiveSha256: "5".repeat(64), archiveBytes: 5 }; }
function sourcePin(version: "before" | "after", revision: string, fill: string) { return { version, revision, compatibilitySha256: fill.repeat(64), platform: "darwin-arm64", mode: "bundled_agent_release" as const, preparedResource: pin(revision, fill), activation: FINAL_ACTIVATION[version] }; }
function authReceipt() { return { schema: "butler.provider-auth-preflight-receipt.v1" as const, authority: "butler_auth_status_and_model_catalog" as const, provider: "openai" as const, authMode: "managed" as const, observedProductAuthMode: "codex_oauth" as const, observedProductAuthSource: "CODEX_AUTH_JSON" as const, model: "openai/gpt-5.6-sol" as const, reasoning: "medium" as const, executionMode: "ordinary_non_fast" as const, modelCallability: "available" as const, configured: true }; }
function authExecutor(): CommandExecutor { return { async execute(request) { const auth = request.args[0] === "auth"; return { exitCode: 0,
  stdout: JSON.stringify({ ok: true, data: auth ? { configured: true, mode: "codex_oauth", source: "CODEX_AUTH_JSON", redacted: true } : { source: "bundled-catalog", models: ["openai/gpt-5.6-sol"] } }),
  stderr: "", startedAtMs: 1, endedAtMs: 2, firstOutputAtMs: 1, outputComplete: true, timedOut: false, cancelled: false }; } }; }
function available() { return { available: true, executable: "fake", version: "1", authenticated: true, configVerified: true, gateCode: "none" as const, diagnostic: null }; }
function fileSha(path: string) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
