import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  createBenchmarkPlan,
  createFileCheckpointStore,
  runAgentBenchmark,
  runAgentBenchmarkCli,
  summarizeBenchmarkResult,
  writeBenchmarkReport,
} from "../support/agent-benchmark/index.ts";
import {
  corroborateExecution,
  createPairedCampaignContract,
  FINAL_AFTER_REVISION,
  FINAL_BEFORE_REVISION,
  replacementEligibility,
  requireAvailableProviderAuth,
  validatePairedCampaignContract,
} from "../support/agent-benchmark/paired-contract.ts";
import {
  aggregatePairedMetrics,
  comparableIdentityForArm,
  comparisonIndexForResult,
  comparisonIndexHtml,
  pairEligibility,
} from "../support/agent-benchmark/paired-evaluation.ts";
import { hashBenchmarkFixture, loadM1V2BenchmarkFixtures } from "../support/agent-benchmark/fixtures.ts";
import type { PreparedButlerResourceReference } from "../support/agent-benchmark/prepared-butler-resource.ts";
import type { AdapterRunInput, AdapterRunResult, AgentAdapter } from "../support/agent-benchmark/contracts.ts";
import { createGatedBenchmarkObservation, resumeOrInitialize } from "../support/agent-benchmark/checkpoint.ts";
import { prepareTestHarnessAuthority } from "./support/m1-v2-provenance-authority.ts";

const root = mkdtempSync(join(process.cwd(), ".agent-benchmark-paired-contract-"));
const authority = prepareTestHarnessAuthority(root);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("final paired M1 campaign contract", () => {
  test("freezes 24 adjacent before/after steps and pathless public identity", () => {
    const contract = pairedContract();
    expect(contract.steps).toHaveLength(24);
    expect(contract.steps.map((step) => `${step.fixture}:${step.repetition}:${step.version}`)).toEqual([
      "direct-cold:1:before", "direct-cold:1:after",
      "direct-warm:1:before", "direct-warm:1:after",
      "current-web-cold:1:before", "current-web-cold:1:after",
      "landing-cold:1:before", "landing-cold:1:after",
      "direct-cold:2:before", "direct-cold:2:after",
      "direct-warm:2:before", "direct-warm:2:after",
      "current-web-cold:2:before", "current-web-cold:2:after",
      "landing-cold:2:before", "landing-cold:2:after",
      "direct-cold:3:before", "direct-cold:3:after",
      "direct-warm:3:before", "direct-warm:3:after",
      "current-web-cold:3:before", "current-web-cold:3:after",
      "landing-cold:3:before", "landing-cold:3:after",
    ]);
    expect(JSON.stringify(contract)).not.toContain(root);
    expect(new Set(contract.steps.map((step) => step.block)).size).toBe(12);
    expect(contract.policy).toMatchObject({ runtimeReorderAllowed: false, postProviderReplacementAllowed: false });

    const plan = createBenchmarkPlan({
      campaign: "m1-v2-paired", runId: "paired-contract", seed: 20260813,
      runRoot: join(root, "run"), sourceRoot: join(root, "after-source"),
      harnessRoot: authority.harnessRoot, provenanceJsonlPath: authority.jsonlPath,
      baselineSha: FINAL_AFTER_REVISION, controlledModel: "openai/gpt-5.6-sol",
      controlledReasoning: "medium", pairedCampaign: contract,
      pairedRuntimeSources: { before: join(root, "before-source"), after: join(root, "after-source") },
    });
    expect(plan.arms).toHaveLength(24);
    expect(plan.arms.map((arm) => arm.key)).toEqual(contract.steps.map((step) => step.key));
    expect(plan.arms.every((arm, index) => arm.sourceRevision === contract.steps[index]!.source.revision)).toBe(true);

    const forged = structuredClone(contract);
    forged.steps = forged.steps.map((step) => ({
      ...step, fixture: "direct-cold", fixtureSha256: forged.fixtureHashes["direct-cold"],
    }));
    const { identity: _identity, ...stable } = forged;
    forged.identity = createHash("sha256").update(JSON.stringify(stable)).digest("hex");
    expect(() => validatePairedCampaignContract(forged)).toThrow("identity mismatch");
    for (const [label, mutate] of [
      ["execution", (value: typeof forged) => { value.execution.serviceTier = "priority" as "default"; }],
      ["auth", (value: typeof forged) => { value.authReceipt.authMode = "oauth" as "managed"; }],
      ["policy", (value: typeof forged) => { value.policy.postProviderReplacementAllowed = true as false; }],
      ["acceptance", (value: typeof forged) => { (value.acceptance.requestHypothesis as { afterMaximum: number }).afterMaximum = 44; }],
      ["prepared", (value: typeof forged) => { value.before.preparedResource.archiveBytes += 1; }],
      ["provenance", (value: typeof forged) => { value.provenance.verifiedSha256 = "z".repeat(64); }],
    ] as const) {
      const priorityForgery = structuredClone(contract);
      mutate(priorityForgery);
      const { identity: _forgedIdentity, ...forgedStable } = priorityForgery;
      priorityForgery.identity = createHash("sha256").update(JSON.stringify(forgedStable)).digest("hex");
      expect(() => validatePairedCampaignContract(priorityForgery), label).toThrow();
    }
  });

  test("fails closed for stale or cross-version prepared pins", () => {
    expect(() => createPairedCampaignContract({
      before: sourcePin("before", FINAL_BEFORE_REVISION, "1"),
      after: sourcePin("after", FINAL_AFTER_REVISION, "1"),
      execution: execution(), authReceipt: authReceipt(), fixtureHashes: fixtureHashes(), provenance: verifyProvenance(),
    })).toThrow("distinct");
    expect(() => createPairedCampaignContract({
      before: { ...sourcePin("before", FINAL_BEFORE_REVISION, "1"), preparedResource: pin(FINAL_AFTER_REVISION, "1") },
      after: sourcePin("after", FINAL_AFTER_REVISION, "2"),
      execution: execution(), authReceipt: authReceipt(), fixtureHashes: fixtureHashes(), provenance: verifyProvenance(),
    })).toThrow("before source/prepared-resource pin mismatch");
  });

  test("auth unavailable stops before manifest creation and available CLI creates redacted plan", async () => {
    const runRoot = join(root, "cli-run");
    const files = writeCliInputs("cli");
    const unavailableAuth = join(root, "unavailable-auth.json");
    writeFileSync(unavailableAuth, JSON.stringify({
      schema: "butler.provider-auth-preflight-receipt.v1", authority: "butler_auth_status_and_model_catalog",
      provider: "openai", authMode: "managed", observedProductAuthMode: "codex_oauth", model: "openai/gpt-5.6-sol",
      reasoning: "medium", executionMode: "ordinary_non_fast",
      modelCallability: "available", configured: false,
    }));
    await expect(runAgentBenchmarkCli(cliArgs(runRoot, files, unavailableAuth)))
      .rejects.toThrow("measurement_unavailable");
    expect(existsSync(join(runRoot, "manifest.json"))).toBe(false);

    const availableAuth = join(root, "available-auth.json");
    writeFileSync(availableAuth, JSON.stringify({
      schema: "butler.provider-auth-preflight-receipt.v1", authority: "butler_auth_status_and_model_catalog",
      provider: "openai", authMode: "managed", observedProductAuthMode: "codex_oauth", model: "openai/gpt-5.6-sol",
      reasoning: "medium", executionMode: "ordinary_non_fast",
      modelCallability: "available", configured: true,
    }));
    const output = JSON.parse(await runAgentBenchmarkCli(cliArgs(runRoot, files, availableAuth))) as { arms: number };
    expect(output.arms).toBe(24);
    const manifest = readFileSync(join(runRoot, "manifest.json"), "utf8");
    expect(manifest).not.toContain(root);
    expect(manifest).toContain("ordinary_non_fast");
    expect(manifest).toContain('"service_tier": "default"');
    await runAgentBenchmarkCli(cliArgs(runRoot, files, availableAuth));
    expect(readFileSync(join(runRoot, "manifest.json"), "utf8")).toBe(manifest);
    writeFileSync(availableAuth, JSON.stringify({
      schema: "butler.provider-auth-preflight-receipt.v1", authority: "butler_auth_status_and_model_catalog",
      provider: "openai", authMode: "managed", observedProductAuthMode: "codex_subscription", model: "openai/gpt-5.6-sol",
      reasoning: "medium", executionMode: "ordinary_non_fast",
      modelCallability: "available", configured: true,
    }));
    await expect(runAgentBenchmarkCli(cliArgs(runRoot, files, availableAuth)))
      .rejects.toThrow("Provider auth preflight is invalid");
  });

  test("uses the public workflow checkpoint and report path without dispatch when source is unavailable", async () => {
    const contract = pairedContract();
    const plan = createBenchmarkPlan({
      campaign: "m1-v2-paired", runId: "paired-workflow", seed: 1,
      runRoot: join(root, "workflow-run"), sourceRoot: join(root, "absent-after"),
      harnessRoot: authority.harnessRoot, provenanceJsonlPath: authority.jsonlPath,
      baselineSha: FINAL_AFTER_REVISION, controlledModel: "openai/gpt-5.6-sol",
      controlledReasoning: "medium", pairedCampaign: contract,
      pairedRuntimeSources: { before: join(root, "absent-before"), after: join(root, "absent-after") },
    });
    let dispatches = 0;
    const adapter = (agent: AgentAdapter["agent"]): AgentAdapter => ({
      agent,
      async preflight() { return { available: true, executable: "provider-free", version: "1", authenticated: true, configVerified: true, gateCode: "none", diagnostic: null }; },
      async run() { dispatches += 1; throw new Error("must not dispatch"); },
    });
    const completed = await runAgentBenchmark({
      plan, adapters: { butler: adapter("butler"), hermes: adapter("hermes"), opencode: adapter("opencode") },
      store: createFileCheckpointStore(join(plan.runRoot, "result.json")),
      signal: new AbortController().signal, landingValidator: async () => {
        throw new Error("must not validate landing");
      }, mode: "preflight-only",
    });
    expect(dispatches).toBe(0);
    expect(completed.result.observations).toHaveLength(24);
    expect(completed.result.observations.every((row) => row.gateCode === "configuration_unverifiable")).toBe(true);
    expect(summarizeBenchmarkResult(completed.result).pairedCampaign?.acceptance.complete).toBe(false);
    const report = writeBenchmarkReport(completed.result, join(plan.runRoot, "report"));
    expect(readFileSync(report.comparisonIndexPath, "utf8")).toContain('"status": "unranked"');
    expect(readFileSync(report.comparisonHtmlPath, "utf8")).toContain("paired_incomplete_or_rejected");

    const replacementPlan = createBenchmarkPlan({
      campaign: "m1-v2-paired", runId: "paired-replacement", seed: 1,
      runRoot: join(root, "replacement-run"), sourceRoot: join(root, "absent-after"),
      harnessRoot: authority.harnessRoot, provenanceJsonlPath: authority.jsonlPath,
      baselineSha: FINAL_AFTER_REVISION, controlledModel: "openai/gpt-5.6-sol",
      controlledReasoning: "medium", pairedCampaign: contract,
      pairedRuntimeSources: { before: join(root, "absent-before"), after: join(root, "absent-after") },
    });
    const checkpoint = resumeOrInitialize(replacementPlan, null);
    checkpoint.observations.push(createGatedBenchmarkObservation(replacementPlan.arms[0]!, {
      available: false, executable: null, version: null, authenticated: true,
      configVerified: false, gateCode: "measurement_unavailable",
      diagnostic: "pre-provider infrastructure unavailable",
    }));
    const replacementStore = createFileCheckpointStore(join(replacementPlan.runRoot, "result.json"));
    await replacementStore.save(checkpoint);
    const resumed = await runAgentBenchmark({
      plan: replacementPlan,
      adapters: { butler: adapter("butler"), hermes: adapter("hermes"), opencode: adapter("opencode") },
      store: replacementStore, signal: new AbortController().signal,
      landingValidator: async () => { throw new Error("must not validate landing"); },
      mode: "execute",
    });
    expect(resumed.result.replacements).toHaveLength(1);
    expect(resumed.result.replacements?.[0]?.reason).toBe("pre_provider_infrastructure_replacement");
  });

  test("runs the public paired plan through available fake adapter, evaluator, report, and index", async () => {
    const beforeRoot = join(root, "available-before"), afterRoot = join(root, "available-after");
    for (const [path, revision] of [[beforeRoot, FINAL_BEFORE_REVISION], [afterRoot, FINAL_AFTER_REVISION]] as const) {
      execFileSync("git", ["clone", "--quiet", "--no-checkout", process.cwd(), path]);
      execFileSync("git", ["-C", path, "checkout", "--quiet", revision]);
    }
    const runRoot = join(root, "available-run"), files = writeCliInputs("available"), auth = join(root, "available-receipt.json");
    writeFileSync(auth, JSON.stringify(authReceipt()));
    let dispatches = 0;
    const butler: AgentAdapter = { agent: "butler",
      async preflight() { return { available: true, executable: "provider-free-fake", version: "1", authenticated: true, configVerified: true, gateCode: "none", diagnostic: null }; },
      async run(input) { dispatches += 1; return completeFakeResult(input); } };
    const unavailable = (agent: "hermes" | "opencode"): AgentAdapter => ({ agent,
      async preflight() { throw new Error("external preflight must not run"); }, async run() { throw new Error("external run must not run"); } });
    const args = cliArgs(runRoot, files, auth).map((value, index) => index === 0 ? "run" :
      value === join(root, "private-before-source") ? beforeRoot : value === join(root, "private-after-source") ? afterRoot : value);
    args.push("--execute-available");
    const output = JSON.parse(await runAgentBenchmarkCli(args, { createAdapters: () => ({ butler, hermes: unavailable("hermes"), opencode: unavailable("opencode") }),
      landingValidator: async () => { throw new Error("typed landing-cold uses M1 evidence"); } })) as { reportPath: string };
    expect(dispatches).toBe(24);
    expect(readFileSync(join(runRoot, "report", "comparison-index.json"), "utf8")).toContain('"status": "ranked"');
    expect(readFileSync(join(runRoot, output.reportPath), "utf8")).toContain("Registered request 45 to 38-40 gate: pass");
    const rejectedRoot = join(root, "rejected-run"), rejectedArgs = args.map((value) => value === runRoot ? rejectedRoot :
      value === join(runRoot, "report") ? join(rejectedRoot, "report") : value);
    const rejectedButler: AgentAdapter = { ...butler, async run(input) { const result = completeFakeResult(input);
      return { ...result, pairedExecutionEvidence: { ...result.pairedExecutionEvidence!, providerServiceTiers: ["priority"] } }; } };
    await runAgentBenchmarkCli(rejectedArgs, { createAdapters: () => ({ butler: rejectedButler,
      hermes: unavailable("hermes"), opencode: unavailable("opencode") }) });
    expect(readFileSync(join(rejectedRoot, "report", "comparison-index.json"), "utf8")).toContain("paired_incomplete_or_rejected");
    const rejectedResult = JSON.parse(readFileSync(join(rejectedRoot, "result.json"), "utf8")) as { observations: Array<{ terminalState: string }> };
    expect(rejectedResult.observations.every((row) => row.terminalState === "rejected")).toBe(true);
  }, 30_000);

  test("corroborates ordinary non-fast medium and rejects fast/service-tier drift", () => {
    const preregistered = requireAvailableProviderAuth({
      schema: "butler.provider-auth-preflight-receipt.v1", authority: "butler_auth_status_and_model_catalog",
      provider: "openai", authMode: "managed", observedProductAuthMode: "codex_oauth", model: "openai/gpt-5.6-sol",
      reasoning: "medium", executionMode: "ordinary_non_fast",
      modelCallability: "available", configured: true,
    });
    expect(() => corroborateExecution({ preregistered, observed: {
      provider: "openai", model: "openai/gpt-5.6-sol", reasoning: "medium", requestServiceTier: "default",
    } })).not.toThrow();
    expect(() => corroborateExecution({ preregistered, observed: {
      provider: "openai", model: "openai/gpt-5.6-sol", reasoning: "medium", serviceTier: "priority",
    } })).toThrow("non_fast_model_execution_identity_mismatch");
  });

  test("classifies source/fixture/model/cache/route/retry pairing without favorable substitution", () => {
    const before = comparable(FINAL_BEFORE_REVISION);
    const after = comparable(FINAL_AFTER_REVISION);
    expect(pairEligibility({ before, after })).toEqual({ status: "eligible", reason: "exact_pair" });
    expect(pairEligibility({ before, after: { ...after, cache: "miss" } })).toEqual({ status: "descriptive", reason: "cache_mismatch" });
    for (const [field, reason] of [["fixture", "fixture_mismatch"], ["model", "model_mismatch"], ["route", "route_mismatch"]] as const) {
      expect(pairEligibility({ before, after: { ...after, [field]: "changed" } })).toEqual({ status: "rejected", reason });
    }
    expect(pairEligibility({ before, after: { ...after, retryOrdinal: 1 } })).toEqual({ status: "rejected", reason: "retry_contaminated" });
    expect(replacementEligibility({ providerDispatchState: "not_dispatched", infrastructureGateStage: "pre_adapter" }).allowed).toBe(true);
    expect(replacementEligibility({ providerDispatchState: "adapter_entered", infrastructureGateStage: null }).allowed).toBe(false);
    expect(replacementEligibility({ providerDispatchState: "provider_output_observed", infrastructureGateStage: null }).allowed).toBe(false);
    const arm = createBenchmarkPlan({ campaign: "m1-v2-paired", runId: "observed-identity", seed: 3,
      runRoot: join(root, "identity-run"), sourceRoot: join(root, "identity-after"), harnessRoot: authority.harnessRoot,
      provenanceJsonlPath: authority.jsonlPath, baselineSha: FINAL_AFTER_REVISION, controlledModel: "openai/gpt-5.6-sol",
      controlledReasoning: "medium", pairedCampaign: pairedContract(), pairedRuntimeSources: {
        before: join(root, "identity-before"), after: join(root, "identity-after") } }).arms[0]!;
    const observed = comparableIdentityForArm(arm, { agentAttempts: [{ eligibility: "cache_mismatch", retryOrdinal: 0,
      fixtureSha256: arm.fixtureHash, sourceRevision: arm.sourceRevision, modelRef: "openai/gpt-5.6-sol", reasoning: "medium",
      providerId: "openai", authMode: "managed", executionMode: "ordinary_non_fast", routeId: "openai-responses" }] } as never);
    expect(observed?.cache).toBe("cache_mismatch");
    expect(comparableIdentityForArm(arm, { agentAttempts: [{ ...observedAttempt(arm), routeId: "drift" }, observedAttempt(arm)] } as never)?.route).toBe("observed_conflict:routeId");
  });

  test("reports per-arm/overall paired deltas, nullable usage, and historical unranked index", () => {
    const usage = { promptTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null };
    const rows = (["direct-cold", "direct-warm", "current-web-cold", "landing-cold"] as const).flatMap((fixture, index) => [1, 2, 3].flatMap((repetition) => [
      { pairId: `${fixture}:${repetition}`, fixture, version: "before" as const, identity: comparable(FINAL_BEFORE_REVISION), providerSendBytes: 100 + index, physicalRequests: 10, modelRounds: 8, toolCalls: 4, elapsedMs: 1000, firstUsefulMs: 100, usage, segments: {}, qualityPassed: true },
      { pairId: `${fixture}:${repetition}`, fixture, version: "after" as const, identity: comparable(FINAL_AFTER_REVISION), providerSendBytes: 60 + index, physicalRequests: 6, modelRounds: 5, toolCalls: 4, elapsedMs: 750, firstUsefulMs: 80, usage, segments: {}, qualityPassed: true },
    ]));
    const aggregate = aggregatePairedMetrics(rows);
    expect(aggregate.byArm["direct-cold"].providerSendBytes.ratio.median).toBe(-0.4);
    expect(aggregate.overall.pairs).toBe(12);
    expect(aggregate.overall.providerSendBytes.total).toMatchObject({ before: 1218, after: 738, delta: -480 });
    expect(aggregate.overall.usage.totalTokens.total.ratio).toBeNull();
    expect(aggregate.overall.qualityPassed).toBe(true);

    expect(aggregate.complete).toBe(true);
    expect(aggregate.byArm["landing-cold"].pairs).toBe(3);
    const rejectedLanding = rows.map((row) => row.fixture === "landing-cold" && row.version === "after"
      ? { ...row, qualityPassed: false } : row);
    expect(aggregatePairedMetrics(rejectedLanding).overall.qualityPassed).toBe(false);
  });
});

function pairedContract() {
  return createPairedCampaignContract({
    before: sourcePin("before", FINAL_BEFORE_REVISION, "1"),
    after: sourcePin("after", FINAL_AFTER_REVISION, "2"),
    execution: execution(), authReceipt: authReceipt(), fixtureHashes: fixtureHashes(),
    provenance: verifyProvenance(),
  });
}

function verifyProvenance() {
  return JSON.parse(JSON.stringify(createBenchmarkPlan({
    campaign: "m1-v2", runId: "provenance-only", seed: 1,
    runRoot: join(root, "provenance-run"), sourceRoot: process.cwd(),
    harnessRoot: authority.harnessRoot, provenanceJsonlPath: authority.jsonlPath,
    baselineSha: "a".repeat(40), controlledModel: "openai/gpt-5.6-sol",
    controlledReasoning: "medium",
  }).provenance!));
}

function fixtureHashes() {
  return Object.fromEntries(loadM1V2BenchmarkFixtures(authority.harnessRoot)
    .map((fixture) => [fixture.id, hashBenchmarkFixture(fixture)])) as Record<"direct-cold" | "direct-warm" | "current-web-cold" | "landing-cold", string>;
}

function execution() {
  return { provider: "openai" as const, authMode: "managed" as const, model: "openai/gpt-5.6-sol" as const, reasoning: "medium" as const, executionMode: "ordinary_non_fast" as const, serviceTier: "default" as const, requestOption: { service_tier: "default" as const } };
}

function authReceipt() { return { schema: "butler.provider-auth-preflight-receipt.v1" as const,
  authority: "butler_auth_status_and_model_catalog" as const, provider: "openai" as const, authMode: "managed" as const,
  observedProductAuthMode: "codex_oauth" as const, model: "openai/gpt-5.6-sol" as const, reasoning: "medium" as const,
  executionMode: "ordinary_non_fast" as const, modelCallability: "available" as const, configured: true }; }

function sourcePin(version: "before" | "after", revision: string, fill: string) {
  return { version, revision, compatibilitySha256: fill.repeat(64), platform: "darwin-arm64", mode: "bundled_agent_release" as const, preparedResource: pin(revision, fill) };
}

function pin(revision: string, fill: string) {
  return { sourceRevision: revision, sourceCompatibilitySha256: fill.repeat(64), manifestSha256: "3".repeat(64), dependencyClosureSha256: "4".repeat(64), resourceSha256: fill.repeat(64), resourceBytes: 10, archiveSha256: "5".repeat(64), archiveBytes: 5 };
}

function reference(revision: string, fill: string): PreparedButlerResourceReference {
  return { resourceDir: join(root, `private-resource-${fill}`), ...pin(revision, fill) };
}

function writeCliInputs(id: string) {
  const before = join(root, `${id}-before-pin.json`);
  const after = join(root, `${id}-after-pin.json`);
  writeFileSync(before, JSON.stringify(reference(FINAL_BEFORE_REVISION, "1")));
  writeFileSync(after, JSON.stringify(reference(FINAL_AFTER_REVISION, "2")));
  return { before, after };
}

function cliArgs(runRoot: string, files: { before: string; after: string }, auth: string): string[] {
  return ["plan", "--campaign", "m1-v2-paired", "--seed", "20260813", "--run-id", "paired-cli", "--run-root", runRoot, "--output", join(runRoot, "report"), "--harness-root", authority.harnessRoot, "--provenance-jsonl", authority.jsonlPath, "--controlled-model", "openai/gpt-5.6-sol", "--controlled-reasoning", "medium", "--source-revision", FINAL_AFTER_REVISION, "--repetitions", "3", "--before-source-root", join(root, "private-before-source"), "--after-source-root", join(root, "private-after-source"), "--before-prepared-butler-resource-pin", files.before, "--after-prepared-butler-resource-pin", files.after, "--provider-auth-preflight", auth];
}

function comparable(sourceRevision: string) {
  return { fixture: "direct-cold", sourceRevision, model: "openai/gpt-5.6-sol", reasoning: "medium", executionMode: "ordinary_non_fast", provider: "openai", authMode: "managed", cache: "eligible", route: "openai-responses", retryOrdinal: 0 };
}

function observedAttempt(arm: import("../support/agent-benchmark/contracts.ts").BenchmarkArmPlan) { return {
  eligibility: "eligible", retryOrdinal: 0, fixtureSha256: arm.fixtureHash, sourceRevision: arm.sourceRevision,
  modelRef: "openai/gpt-5.6-sol", reasoning: "medium", providerId: "openai", authMode: "managed",
  executionMode: "ordinary_non_fast", routeId: "openai-responses",
}; }

function completeFakeResult(input: AdapterRunInput): AdapterRunResult {
  const { arm, fixture } = input, before = arm.version === "before";
  const requestCount = before ? (arm.order < 18 ? 4 : 3) : (arm.order < 6 ? 4 : 3);
  const sessionId = `fake-${arm.key}`, turnId = `turn-${arm.order}`, now = Date.now();
  const attempts = Array.from({ length: requestCount }, (_, index) => {
    const attemptDigest = `${String.fromCharCode(65 + (arm.order % 20))}${String(index)}`.padEnd(43, "A");
    return { attemptDigest, ordinal: index + 1 };
  });
  const finalText = arm.scenario === "current-web-cold"
    ? "2026년 8월 10일 기준 우산을 챙기세요. https://weather.go.kr https://example.com"
    : arm.scenario === "landing-cold" ? "Butler durable project work landing" : "안녕하세요.";
  const work = { status: "completed", planRevision: 1, checkpointStage: "complete", checkpointStages: ["plan", "result"],
    planReviewVerdict: "accept", resultReviewVerdict: "accept", completionValidationVerdict: "accept", resultToolNames: ["tool"],
    projectLedgerWorkRecords: 1, projectLedgerCompletedWorkRecords: 1, projectLedgerCloseoutObserved: true };
  const evidence = { ok: true, generatedAt: new Date(now).toISOString(),
    run: { runRoot: arm.evidenceRoot, workspaceRoot: `${arm.evidenceRoot}/workspace`, model: "openai/gpt-5.6-sol", reasoningEffort: "medium" },
    isolation: { bindingWorkspace: `${arm.evidenceRoot}/workspace`, workspaceInsideRunRoot: true, sourceDataIsRunData: false },
    session: { id: sessionId }, observations: [{ stepId: fixture.m1V2!.targetStepId, sessionId, turnId, terminalState: "delivered",
      promptSha256: fixture.m1V2!.promptSha256[fixture.m1V2!.targetStepId], finalText, providerReportedModel: "gpt-5.6-sol",
      providerAgentModels: ["gpt-5.6-sol"], timing: { submittedAtMs: now, terminalAtMs: now + 100, elapsedMs: before ? 100 : 75 },
      reload: { tested: true, finalMatched: true }, providerRequestIdentities: attempts.map((item) => ({ ...item, sessionId, turnId, requestKind: "agent" })), work }],
    providerRequests: attempts.map((item) => ({ ...item, requestKind: "agent", requestStartedAtMs: now + 10,
      firstContentBearingDeltaAtMs: 10, completedAtMs: now + 50, terminatedAtMs: now + 50, serializedRequestBytes: before ? 100 : 60 })) };
  const metric = (name: string, dimensions: Record<string, string | number | boolean | null>) => ({ schema: "butler.operational-metric.v1" as const,
    ts: now + 50, category: "context" as const, name, status: "ok" as const, dimensions, rawTextStored: false as const });
  const metrics = attempts.flatMap((item, index) => [
    metric("m1_v2_request_envelope", { attemptDigest: item.attemptDigest, armId: arm.scenario, sourceRevision: arm.sourceRevision,
      fixtureSha256: arm.fixtureHash, providerId: "openai", modelRef: "openai/gpt-5.6-sol", reasoning: "medium",
      routeId: "openai-responses", authMode: "managed", executionMode: "ordinary_non_fast", providerSendBytes: before ? 100 : 60,
      eligibility: "eligible", retryOrdinal: 0, roundIndex: index }),
    metric("m1_v2_request_segment", { attemptDigest: item.attemptDigest, segmentId: `segment-${index}`, kind: arm.scenario === "current-web-cold" ? "source_reference" : "provider_carrier_overhead",
      stability: "dynamic", providerSendBytes: before ? 100 : 60, keyedContentDigest: "B".repeat(43) }),
    metric("m1_v2_response_usage", { attemptDigest: item.attemptDigest, status: "unavailable", promptTokens: null,
      cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null }),
  ]);
  const claims = ["butler.durable_project_work.v1", "butler.memory_context.v1", "butler.tools_workspace_authority.v1", "butler.provider_routing.v1", "butler.recovery.v1"] as const;
  const landingValidation = arm.scenario === "landing-cold" ? { buildPassed: true, desktopPassed: true, mobilePassed: true,
    desktopScreenshotPresent: true, mobileScreenshotPresent: true, indexChanged: true, stylesChanged: true, butlerGrounded: true,
    featureBlockCount: 5, usageScenePresent: true, ctaPresent: true, responsiveCssPresent: true, durableProjectWorkGrounded: true,
    memoryContextGrounded: true, toolsWorkspaceGrounded: true, providerRoutingGrounded: true, recoveryGrounded: true, genericCopyAbsent: true,
    approvedCapabilityClaims: claims.map((id) => ({ id, requiredElementsPresent: [true], negated: false, misrepresented: false, passed: true })) } : null;
  const execution = arm.pairedExecution!;
  return { exitCode: 0, gateCode: "none", timedOut: false, cancelled: false, stdout: "", stderr: "", adapterVersion: "fake-1",
    provider: "openai", finalText, sessionId, effectiveConfig: arm.effectiveConfig,
    pairedExecutionEvidence: { provider: execution.provider, model: execution.model, reasoning: execution.reasoning,
      providerServiceTiers: ["default"], requestServiceTiers: ["default"], requestModels: [execution.model],
      requestReasoning: ["medium"], authorizationSchemes: ["bearer"] }, usage: {}, tools: {}, timing: {}, operations: {},
    changedPaths: [], evidenceRefs: [], m1V2Evidence: { evidence, metrics, db: { quickCheckDatabases: 1, quickCheckPassed: true,
      toolCalls: arm.scenario === "landing-cold" ? 3 : 0, webToolCalls: arm.scenario === "current-web-cold" ? 1 : 0,
      pagePreviewToolCalls: arm.scenario === "landing-cold" ? 1 : 0, buildCommandToolCalls: arm.scenario === "landing-cold" ? 1 : 0,
      fileMutationToolCalls: arm.scenario === "landing-cold" ? 1 : 0, duplicateAppliedEffects: 0, unresolvedCorrections: 0, lostRequiredAnchors: 0 },
      landingValidation, sourceRevision: arm.sourceRevision, attemptStartedAtMs: now } };
}
