import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  AGENT_BENCHMARK_BASELINE_SHA,
  AGENT_BENCHMARK_FIXTURES,
  createBenchmarkPlan,
  createFileCheckpointStore,
  deriveAcceptedResultPerToken,
  generateBenchmarkReport,
  hashBenchmarkFixture,
  runAgentBenchmark,
  summarizeBenchmarkResult,
  evaluateWebResearch,
  evaluateAdapterResult,
  benchmarkPlanIdentity,
  runAgentBenchmarkCli,
} from "../support/agent-benchmark/index.ts";
import { createGatedBenchmarkObservation, redactBenchmarkResult, resumeOrInitialize } from "../support/agent-benchmark/checkpoint.ts";
import { ExternalCliAdapter } from "../support/agent-benchmark/external-adapter.ts";
import { createButlerAdapter, promptCacheKeyPrefixForPair } from "../support/agent-benchmark/butler-adapter.ts";
import { copyGeneratedArtifacts } from "../support/agent-benchmark/butler-output.ts";
import { canSettleAfterExit, executeCommand, outputStreamIsComplete, safeEnvironment, type CommandExecutor } from "../support/agent-benchmark/command.ts";
import { commandFor, hermesUsageDiagnosticFor, parseCliOutput, parseHermesUsageFile } from "../support/agent-benchmark/cli-output.ts";
import { materializeEvidenceWorkspace, materializeRepositoryEvidence, readRepositoryEvidenceFiles, verifyEvidenceWorkspace, verifyRepositoryEvidence } from "../support/agent-benchmark/repository-evidence.ts";
import { runtimeInstructions } from "../support/agent-benchmark/workflow.ts";
import { runBenchmarkArm } from "../support/agent-benchmark/workflow-arm.ts";
import { parseOptions } from "../support/agent-benchmark/cli.ts";
import { applyVisualReviews, readVisualReviewFile } from "../support/agent-benchmark/visual-review.ts";
import type {
  AdapterRunInput,
  AdapterRunResult,
  AgentAdapter,
  BenchmarkArmPlan,
  BenchmarkObservation,
  PreflightResult,
} from "../support/agent-benchmark/contracts.ts";
import { prepareElectronRun } from "../e2e/btcc-r3-electron/isolation-config.ts";
import { prepareArmRoots } from "../support/agent-benchmark/isolation.ts";
import { BENCHMARK_SUPPORTED_TRACKS } from "../support/agent-benchmark/planning.ts";

function recommendedArmFrom(arm: BenchmarkArmPlan): BenchmarkArmPlan {
  return {
    ...arm,
    key: `${arm.key}:recommended-fixture`,
    track: "recommended-default",
    cachePairId: `${arm.cachePairId}:recommended-fixture`,
    outputRoot: `${arm.outputRoot}-recommended-fixture`,
    dataRoot: `${arm.dataRoot}-recommended-fixture`,
    evidenceRoot: `${arm.evidenceRoot}-recommended-fixture`,
    cacheRoot: `${arm.cacheRoot}-recommended-fixture`,
    effectiveConfig: {
      model: null,
      reasoning: null,
      permissions: "product-recommended-default",
      tools: ["filesystem", "web", "terminal"],
      memoryEnabled: null,
      skillsEnabled: null,
      pluginsEnabled: null,
      mcpEnabled: null,
      provider: null,
      variant: null,
    },
  };
}

test("agent benchmark plan pins baseline, hashes fixtures, and randomizes deterministically", () => {
  const first = createBenchmarkPlan({
    runId: "run-a",
    seed: 42,
    runRoot: "/tmp/agent-benchmark-run-a",
    sourceRoot: "/tmp/agent-benchmark-source-a",
    controlledModel: "openai/gpt-5.5",
  });
  const second = createBenchmarkPlan({
    runId: "run-b",
    seed: 42,
    runRoot: "/tmp/agent-benchmark-run-b",
    sourceRoot: "/tmp/agent-benchmark-source-b",
    controlledModel: "openai/gpt-5.5",
  });
  const differentSeed = createBenchmarkPlan({
    runId: "run-c",
    seed: 43,
    runRoot: "/tmp/agent-benchmark-run-c",
    sourceRoot: "/tmp/agent-benchmark-source-c",
    controlledModel: "openai/gpt-5.5",
  });
  expect(first.baselineSha).toBe(AGENT_BENCHMARK_BASELINE_SHA);
  expect(first.arms.map((arm) => arm.agent)).toEqual(second.arms.map((arm) => arm.agent));
  expect(first.arms.filter((arm) => arm.scenario === "direct_conversation").map((arm) => arm.agent)).not.toEqual(
    differentSeed.arms.filter((arm) => arm.scenario === "direct_conversation").map((arm) => arm.agent),
  );
  expect(first.tracks).toEqual(["controlled"]);
  expect(BENCHMARK_SUPPORTED_TRACKS).toEqual(["controlled", "recommended-default"]);
  expect(first.arms).toHaveLength(12);
  expect(first.arms.filter((arm) => arm.scenario === "direct_conversation")).toHaveLength(6);
  expect(first.arms.filter((arm) => arm.scenario === "current_web_research")).toHaveLength(3);
  expect(first.arms.filter((arm) => arm.scenario === "butler_landing_page")).toHaveLength(3);
  expect(first.arms.filter((arm) => arm.track === "recommended-default")).toHaveLength(0);
  for (const agent of ["butler", "hermes", "opencode"] as const) {
    expect(first.arms.filter((arm) => arm.agent === agent)).toHaveLength(4);
  }
  for (const pair of new Set(first.arms.filter((arm) => arm.scenario === "direct_conversation").map((arm) => arm.cachePairId))) {
    const arms = first.arms.filter((arm) => arm.cachePairId === pair);
    expect(arms.map((arm) => arm.cache)).toEqual(["cold", "warm"]);
    expect(arms[0]!.cacheRoot).toBe(arms[1]!.cacheRoot);
    expect(arms[0]!.outputRoot).not.toBe(arms[1]!.outputRoot);
  }
  expect(first.fixtures.every((fixture) => fixture.sha256.length === 64)).toBe(true);
  expect(hashBenchmarkFixture(AGENT_BENCHMARK_FIXTURES[0]!)).toBe(first.fixtures[0]!.sha256);
  const hermesControlled = first.arms.find((arm) => arm.agent === "hermes" && arm.track === "controlled")!;
  expect(hermesControlled.effectiveConfig.model).toBe("openai/gpt-5.5");
  expect(hermesControlled.effectiveConfig.provider).toBe("openai-codex");
  expect(hermesControlled.effectiveConfig.reasoning).toBe("medium");
  expect(hermesControlled.effectiveConfig.variant).toBeNull();
  const trimmed = createBenchmarkPlan({ runId: "trimmed-model", seed: 42, runRoot: "/tmp/trimmed-run", sourceRoot: "/tmp/trimmed-source", controlledModel: "  openai/gpt-5.5  " });
  expect(trimmed.arms.find((arm) => arm.track === "controlled" && arm.agent === "butler")!.effectiveConfig.model).toBe("openai/gpt-5.5");
  expect(() => createBenchmarkPlan({ runId: "unsafe-plan", seed: 42, runRoot: "/tmp/unsafe-run", sourceRoot: "/tmp/unsafe-source", controlledModel: "openai/gpt|secret" })).toThrow();
  const solPlan = createBenchmarkPlan({ runId: "sol-plan", seed: 42, runRoot: "/tmp/sol-run", sourceRoot: "/tmp/sol-source", controlledModel: "openai/gpt-5.6-sol", controlledReasoning: "medium" });
  const solHermes = solPlan.arms.find((arm) => arm.agent === "hermes" && arm.track === "controlled")!;
  expect(solHermes.effectiveConfig).toMatchObject({ model: "openai/gpt-5.6-sol", provider: "openai-codex", reasoning: "medium" });
  const nonSolPlan = createBenchmarkPlan({ runId: "non-sol-plan", seed: 42, runRoot: "/tmp/non-sol-run", sourceRoot: "/tmp/non-sol-source", controlledModel: "anthropic/claude-sonnet-4", controlledReasoning: "low" });
  const nonSolHermes = nonSolPlan.arms.find((arm) => arm.agent === "hermes" && arm.track === "controlled" && arm.scenario === "current_web_research")!;
  expect(nonSolHermes.effectiveConfig).toMatchObject({ model: "anthropic/claude-sonnet-4", provider: null, reasoning: "low" });
});

test("Butler paired cache arms resolve one provider cache namespace per pair", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-butler-cache-prefix-"));
  const sourceData = join(root, "source-data");
  mkdirSync(sourceData, { recursive: true });
  writeFileSync(join(sourceData, "butler.config.json"), JSON.stringify({
    models: { registered: [] },
    system: { butlerModel: "local/test-model", defaultModel: "local/test-model" },
  }), "utf8");
  const scenario = {
    schema: "butler.btcc-r3-electron-scenario.v1" as const,
    id: "cache-prefix",
    steps: [{ id: "hello", prompt: "hello" }],
  };
  try {
    await expect(prepareElectronRun(scenario, {
      dryRun: true,
      model: "local/test-model",
      repoRoot: root,
      sourceData,
      runRoot: join(root, "unsafe"),
      promptCacheKeyPrefix: "cache|private",
    })).rejects.toThrow("Prompt cache key prefix");
    const pairPrefix = promptCacheKeyPrefixForPair("direct_conversation|controlled|butler|1");
    const first = await prepareElectronRun(scenario, {
      model: "local/test-model",
      repoRoot: root,
      sourceData,
      runRoot: join(root, "cold"),
      promptCacheKeyPrefix: pairPrefix,
    });
    const second = await prepareElectronRun(scenario, {
      model: "local/test-model",
      repoRoot: root,
      sourceData,
      runRoot: join(root, "warm"),
      promptCacheKeyPrefix: pairPrefix,
    });
    const distinct = await prepareElectronRun(scenario, {
      model: "local/test-model",
      repoRoot: root,
      sourceData,
      runRoot: join(root, "distinct"),
      promptCacheKeyPrefix: promptCacheKeyPrefixForPair("direct_conversation|controlled|hermes|1"),
    });
    const readPrefix = (dataRoot: string): string => String((JSON.parse(readFileSync(join(dataRoot, "butler.config.json"), "utf8")) as { system: { openaiPromptCacheKeyPrefix: string } }).system.openaiPromptCacheKeyPrefix);
    expect(readPrefix(first.dataRoot)).toBe(pairPrefix);
    expect(readPrefix(second.dataRoot)).toBe(pairPrefix);
    expect(readPrefix(distinct.dataRoot)).not.toBe(pairPrefix);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepted-result-per-token is fail-closed for unknown or rejected usage", () => {
  expect(deriveAcceptedResultPerToken("accepted", 2_000, true)).toBe(500);
  expect(deriveAcceptedResultPerToken("rejected", 2_000, false)).toBeNull();
  expect(deriveAcceptedResultPerToken("accepted", null, true)).toBeNull();
});

test("unsafe model identifiers are rejected before observation/report persistence", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-unsafe-model-"));
  const plan = createBenchmarkPlan({ runId: "unsafe-model", seed: 23, runRoot: join(root, "run"), sourceRoot: join(root, "source"), controlledModel: "openai/gpt-5.5" });
  const arm = plan.arms.find((candidate) => candidate.agent === "opencode" && candidate.track === "controlled")!;
  const observation = evaluateAdapterResult(arm, AGENT_BENCHMARK_FIXTURES[0]!, baseAdapterResult({ effectiveConfig: { model: "/Users/private|token=secret" } }));
  expect(observation.terminalState).toBe("gated");
  expect(observation.gateCode).toBe("configuration_unverifiable");
  expect(observation.effectiveConfig.model).toBeNull();
  const result = { schema: "butler.agent-benchmark.v1" as const, kind: "agent_benchmark_result" as const, run: { runId: plan.runId, seed: plan.seed, baselineSha: plan.baselineSha, runRoot: plan.runRoot, state: "reported" as const }, plan, observations: [observation] };
  const path = join(root, "result.json");
  await createFileCheckpointStore(path).save(result);
  const persisted = await (await import("node:fs/promises")).readFile(path, "utf8");
  expect(persisted).not.toContain("/Users/private");
  expect(persisted).not.toContain("token=secret");
  const unsafePlan = { ...plan, arms: plan.arms.map((candidate, index) => index === 0 ? { ...candidate, effectiveConfig: { ...candidate.effectiveConfig, model: "/Users/private|token=secret" } } : candidate) };
  expect(redactBenchmarkResult({ ...result, plan: unsafePlan, observations: [] }).plan.arms[0]!.effectiveConfig.model).toBeNull();
});

test("Butler runtime prompt keeps project workspace output separate from benchmark copy root", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-runtime-prompt-"));
  const plan = createBenchmarkPlan({ runId: "runtime-prompt", seed: 22, runRoot: join(root, "run"), sourceRoot: join(root, "source"), controlledModel: "openai/gpt-5.5" });
  const arm = plan.arms.find((candidate) => candidate.agent === "butler")!;
  const instructions = runtimeInstructions(arm, "evidence-root", "evidence-sha");
  expect(instructions).toContain("current isolated workspace root");
  expect(instructions).toContain("harness copies");
  expect(instructions).not.toContain(`Write generated files only to ${arm.outputRoot}`);
  expect(instructions).not.toContain("evidence-root");
  const directArm = plan.arms.find((candidate) => candidate.scenario === "direct_conversation")!;
  const directInstructions = runtimeInstructions(directArm, "/Users/private/evidence", "hash");
  expect(directInstructions).not.toContain(".benchmark-input/repository");
  expect(directInstructions).not.toContain("/Users/private");
});

test("public benchmark CLI rejects unknown commands", () => {
  expect(() => parseOptions(["unknown", "--seed", "1", "--controlled-model", "openai/gpt-5.5"])).toThrow();
  expect(() => parseOptions(["pilot", "--seed", "1", "--controlled-model", "openai/gpt-5.5", "--typo"])).toThrow();
  expect(() => parseOptions(["pilot", "--seed", "1", "--controlled-model"])).toThrow();
  expect(() => parseOptions(["pilot", "--seed", "1", "--controlled-model", "openai/gpt-5.5"])).toThrow("canonical pilot");
});

test("public benchmark CLI rejects unsafe run ids and report paths outside the run root", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-cli-paths-"));
  expect(() => parseOptions(["pilot", "--seed", "1", "--run-id", "../private|report", "--controlled-model", "openai/gpt-5.5"])).toThrow();
  expect(() => parseOptions(["pilot", "--seed", "1", "--controlled-model", "openai/gpt-5.5", "--run-root", join(root, "run"), "--output", join(root, "outside")])).toThrow();
  const runRoot = join(root, "symlink-run");
  mkdirSync(runRoot, { recursive: true });
  symlinkSync(join(root, "outside-target"), join(runRoot, "report"), "dir");
  expect(() => parseOptions(["pilot", "--seed", "1", "--controlled-model", "openai/gpt-5.5", "--run-root", runRoot, "--output", join(runRoot, "report")])).toThrow();
});

test("visual review input is typed, landing-only, and reportable", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-visual-review-"));
  const plan = createBenchmarkPlan({ runId: "visual-review", seed: 31, runRoot: join(root, "run"), sourceRoot: join(root, "source"), controlledModel: "openai/gpt-5.5" });
  const landingArm = plan.arms.find((arm) => arm.agent === "butler" && arm.scenario === "butler_landing_page" && arm.cache === "cold" && arm.track === "controlled")!;
  const observation = {
    ...emptyObservation(landingArm),
    terminalState: "rejected" as const,
    evidenceRefs: ["evidence/desktop.png", "evidence/mobile.png"],
    evaluation: { ...emptyObservation(landingArm).evaluation, accepted: false },
  };
  const result = { schema: "butler.agent-benchmark.v1" as const, kind: "agent_benchmark_result" as const, run: { runId: plan.runId, seed: plan.seed, baselineSha: plan.baselineSha, runRoot: plan.runRoot, state: "reported" as const }, plan, observations: [observation] };
  const reviewPath = join(root, "review.json");
  writeFileSync(reviewPath, JSON.stringify({ schema: "butler.agent-benchmark.visual-review.v1", reviews: [{ armKey: landingArm.key, score: 4, reviewerLabel: "reviewer-1", rubricVersion: "landing-rubric-v1" }] }), "utf8");
  const reviewFile = readVisualReviewFile(reviewPath);
  const reviewed = applyVisualReviews(result, reviewFile);
  const reapplied = applyVisualReviews(reviewed, reviewFile);
  expect(reviewed.observations[0]!.visualReview).toEqual({ score: 4, reviewerLabel: "reviewer-1", rubricVersion: "landing-rubric-v1" });
  expect(reapplied.observations[0]!.evaluation.evaluatorNotes.filter((note) => note.startsWith("visual-review:")).length).toBe(1);
  expect(reviewed.observations[0]!.evaluation.visualQuality).toBe(4);
  expect(generateBenchmarkReport(reviewed)).toContain("reviewer-1");
  expect(generateBenchmarkReport(reviewed)).toContain("landing-rubric-v1");
  const checkpoint = createFileCheckpointStore(join(root, "visual-result.json"));
  await checkpoint.save(result);
  await expect(checkpoint.save(reviewed)).resolves.toBeUndefined();
  writeFileSync(reviewPath, JSON.stringify({ schema: "butler.agent-benchmark.visual-review.v1", reviews: [{ armKey: landingArm.key, score: 6, reviewerLabel: "reviewer-1", rubricVersion: "landing-rubric-v1" }] }), "utf8");
  expect(() => readVisualReviewFile(reviewPath)).toThrow();
  expect(() => applyVisualReviews(result, { schema: "butler.agent-benchmark.visual-review.v1", reviews: [{ armKey: plan.arms[0]!.key, score: 4, reviewerLabel: "reviewer-1", rubricVersion: "landing-rubric-v1" }] })).toThrow();
  expect(() => applyVisualReviews({ ...result, observations: [{ ...observation, terminalState: "gated" as const, evidenceRefs: [] }] }, reviewFile)).toThrow();
  expect(() => applyVisualReviews({ ...result, observations: [{ ...observation, evidenceRefs: ["evidence/desktop.png"] }] }, reviewFile)).toThrow();
});

test("source authority gates non-git and dirty checkouts before any arm", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-source-gate-"));
  const plan = createBenchmarkPlan({ runId: "source-gate", seed: 12, runRoot: join(root, "run"), sourceRoot: join(root, "not-git"), controlledModel: "openai/gpt-5.5" });
  const calls: string[] = [];
  const adapters = {
    butler: fakeAdapter(calls, "butler"),
    hermes: fakeAdapter(calls, "hermes"),
    opencode: fakeAdapter(calls, "opencode"),
  } as const;
  const result = await runAgentBenchmark({ plan, adapters, store: createFileCheckpointStore(join(plan.runRoot, "result.json")), signal: new AbortController().signal, landingValidator: async () => validLanding(), mode: "execute" });
  expect(result.result.observations.every((observation) => observation.gateCode === "configuration_unverifiable")).toBe(true);
  expect(calls).toHaveLength(0);
});

test("benchmark root validation rejects symlinked source authorities", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-symlink-root-"));
  const realSource = join(root, "real-source");
  const sourceLink = join(root, "source-link");
  mkdirSync(realSource, { recursive: true });
  symlinkSync(realSource, sourceLink, "dir");
  const plan = createBenchmarkPlan({ runId: "symlink-root", seed: 34, runRoot: join(root, "run"), sourceRoot: sourceLink, controlledModel: "openai/gpt-5.5" });
  const adapters = { butler: fakeAdapter([], "butler"), hermes: fakeAdapter([], "hermes"), opencode: fakeAdapter([], "opencode") } as const;
  await expect(runAgentBenchmark({ plan, adapters, store: createFileCheckpointStore(join(plan.runRoot, "result.json")), signal: new AbortController().signal, landingValidator: async () => validLanding(), mode: "execute" })).rejects.toThrow("symlink");
});

test("public pilot command stays preflight-only without execute flag", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-pilot-smoke-"));
  const output = await runAgentBenchmarkCli([
    "pilot",
    "--seed",
    "19",
    "--controlled-model",
    "openai/gpt-5.6-sol",
    "--controlled-reasoning",
    "medium",
    "--run-root",
    join(root, "run"),
    "--source-root",
    process.cwd(),
    "--output",
    join(root, "run", "report"),
  ]);
  expect(JSON.parse(output).gates).toBe(12);
});

test("workflow preflight-only mode never launches arms on a clean pinned baseline", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-preflight-workflow-"));
  const sourceRoot = join(root, "source");
  // Keep a real clean pinned checkout while reusing local Git objects; the
  // workflow itself still performs the authoritative SHA/clean-status gate.
  execFileSync("git", ["clone", "--quiet", "--local", process.cwd(), sourceRoot], { stdio: "ignore" });
  execFileSync("git", ["-C", sourceRoot, "checkout", "--quiet", "--detach", AGENT_BENCHMARK_BASELINE_SHA], { stdio: "ignore" });
  const calls: string[] = [];
  const adapters = {
    butler: fakeAdapter(calls, "butler"),
    hermes: fakeAdapter(calls, "hermes"),
    opencode: fakeAdapter(calls, "opencode"),
  } as const;
  const plan = createBenchmarkPlan({ runId: "preflight-workflow", seed: 37, runRoot: join(root, "run"), sourceRoot, controlledModel: "openai/gpt-5.5" });
  const result = await runAgentBenchmark({ plan, adapters, store: createFileCheckpointStore(join(plan.runRoot, "result.json")), signal: new AbortController().signal, landingValidator: async () => validLanding(), mode: "preflight-only" });
  expect(result.result.run.state).toBe("reported");
  expect(result.result.observations).toHaveLength(plan.arms.length);
  expect(result.result.observations.every((observation) => observation.gateCode === "measurement_unavailable")).toBe(true);
  expect(calls).toHaveLength(0);
  rmSync(root, { recursive: true, force: true });
}, 30_000);

test("landing evidence failure gates only landing arms, not direct or web arms", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-landing-evidence-scope-"));
  const sourceRoot = join(root, "source");
  // This regression still exercises a real clean pinned Git checkout, but
  // keeps the local object store hard-linked so the source-integrity check
  // does not spend its entire timeout copying the repository's history.
  execFileSync("git", ["clone", "--quiet", "--local", process.cwd(), sourceRoot], { stdio: "ignore" });
  execFileSync("git", ["-C", sourceRoot, "checkout", "--quiet", "--detach", AGENT_BENCHMARK_BASELINE_SHA], { stdio: "ignore" });
  const plan = createBenchmarkPlan({ runId: "landing-evidence-scope", seed: 38, runRoot: join(root, "run"), sourceRoot, controlledModel: "openai/gpt-5.5" });
  const adapter = fakeAdapter([], "butler");
  const preflight: PreflightResult = { available: true, executable: "fixture", version: "fixture", authenticated: true, configVerified: true, gateCode: "none", diagnostic: null };
  const direct = plan.arms.find((arm) => arm.agent === "butler" && arm.scenario === "direct_conversation" && arm.cache === "cold" && arm.track === "controlled")!;
  const landing = plan.arms.find((arm) => arm.agent === "butler" && arm.scenario === "butler_landing_page" && arm.cache === "cold" && arm.track === "controlled")!;
  const directObservation = await runBenchmarkArm({ arm: direct, adapter, preflight, signal: new AbortController().signal, planRunRoot: plan.runRoot, harnessRoot: plan.harnessRoot, landingValidator: async () => validLanding(), evidenceSnapshot: null, sourceDiagnostic: null, evidenceDiagnostic: "evidence materialization failed" });
  const landingObservation = await runBenchmarkArm({ arm: landing, adapter, preflight, signal: new AbortController().signal, planRunRoot: plan.runRoot, harnessRoot: plan.harnessRoot, landingValidator: async () => validLanding(), evidenceSnapshot: null, sourceDiagnostic: null, evidenceDiagnostic: "evidence materialization failed" });
  expect(directObservation.gateCode).not.toBe("configuration_unverifiable");
  expect(landingObservation.gateCode).toBe("configuration_unverifiable");
  rmSync(root, { recursive: true, force: true });
}, 30_000);

test("preflight-resolved model survives a gated controlled observation", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-preflight-config-"));
  const plan = createBenchmarkPlan({ runId: "preflight-config", seed: 35, runRoot: join(root, "run"), sourceRoot: join(root, "source"), controlledModel: "openai/gpt-5.5" });
  const arm = plan.arms.find((candidate) => candidate.agent === "hermes" && candidate.track === "controlled")!;
  const observation = createGatedBenchmarkObservation(arm, { available: false, executable: "hermes", version: "hermes-1", authenticated: false, configVerified: false, gateCode: "authentication_unavailable", diagnostic: "auth unavailable", effectiveConfig: { model: "resolved/hermes-model" } });
  expect(observation.effectiveConfig.model).toBe("resolved/hermes-model");
});

test("resume rejects a changed plan/config identity", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-identity-"));
  const plan = createBenchmarkPlan({ runId: "identity", seed: 13, runRoot: join(root, "run"), sourceRoot: join(root, "source"), controlledModel: "openai/gpt-5.5" });
  const prior = resumeOrInitialize(plan, null);
  prior.observations.push(emptyObservation(plan.arms[0]!));
  const changed = createBenchmarkPlan({ runId: plan.runId, seed: plan.seed, runRoot: plan.runRoot, sourceRoot: plan.sourceRoot, controlledModel: "anthropic/claude-sonnet-4" });
  expect(benchmarkPlanIdentity(plan)).not.toBe(benchmarkPlanIdentity(changed));
  expect(() => resumeOrInitialize(changed, prior)).toThrow("checkpoint identity mismatch");
  const changedPath = {
    ...plan,
    arms: plan.arms.map((arm, index) => index === 0 ? { ...arm, outputRoot: `${arm.outputRoot}-changed` } : arm),
  };
  expect(benchmarkPlanIdentity(plan)).not.toBe(benchmarkPlanIdentity(changedPath));
  expect(() => resumeOrInitialize(changedPath, prior)).toThrow("checkpoint identity mismatch");
});

test("pinned repository evidence detects post-materialization mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-evidence-"));
  const source = join(root, "source");
  const destination = join(root, "evidence");
  mkdirSync(join(source, "packages", "nested"), { recursive: true });
  writeFileSync(join(source, "README.md"), "pinned", "utf8");
  writeFileSync(join(source, "package.json"), "{}", "utf8");
  const snapshot = materializeRepositoryEvidence(source, destination);
  expect(verifyRepositoryEvidence(snapshot).ok).toBe(true);
  writeFileSync(join(destination, "README.md"), "mutated", "utf8");
  expect(verifyRepositoryEvidence(snapshot).ok).toBe(false);
});

test("Butler landing evidence uses a read-only input namespace and detects workspace mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-evidence-workspace-"));
  const source = join(root, "source");
  const snapshotRoot = join(root, "snapshot");
  const workspace = join(root, "workspace");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "README.md"), "pinned", "utf8");
  writeFileSync(join(source, "package.json"), "{}", "utf8");
  const snapshot = materializeRepositoryEvidence(source, snapshotRoot);
  const fixtureFiles = readRepositoryEvidenceFiles(snapshot.root);
  expect(fixtureFiles.every((file) => file.path.startsWith(".benchmark-input/repository/"))).toBe(true);
  for (const file of fixtureFiles) {
    const path = join(workspace, file.path);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, file.text, "utf8");
  }
  expect(verifyEvidenceWorkspace(snapshot, workspace).ok).toBe(true);
  const externalWorkspace = join(root, "external-workspace");
  materializeEvidenceWorkspace(snapshot, externalWorkspace);
  expect(verifyEvidenceWorkspace(snapshot, externalWorkspace).ok).toBe(true);
  writeFileSync(join(workspace, ".benchmark-input/repository/README.md"), "mutated", "utf8");
  expect(verifyEvidenceWorkspace(snapshot, workspace).ok).toBe(false);
});

test("Butler adapter uses the last turn and BTCC telemetry when present", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-butler-evidence-"));
  writeFileSync(join(root, "package.json"), '{"version":"fixture-butler-1"}', "utf8");
  const plan = createBenchmarkPlan({ runId: "butler-evidence", seed: 15, runRoot: join(root, "run"), sourceRoot: join(root, "source"), controlledModel: "openai/gpt-5.5" });
  const arm = plan.arms.find((candidate) => candidate.agent === "butler" && candidate.scenario === "direct_conversation" && candidate.cache === "cold" && candidate.track === "controlled")!;
  const dataRoot = join(arm.evidenceRoot, "data");
  mkdirSync(join(dataRoot, "metrics"), { recursive: true });
  mkdirSync(join(dataRoot, "transcripts"), { recursive: true });
  writeFileSync(join(dataRoot, "metrics", "prompt-cache-usage.jsonl"), JSON.stringify({ model: "gpt-5.5", promptTokens: 4, cachedTokens: 1, totalTokens: 7, ts: Date.now() }) + "\n", "utf8");
  writeFileSync(join(dataRoot, "transcripts", "turns.jsonl"), [
    { payload: { metadata: { turnId: "first", event: { kind: "tool.started", createdAt: new Date(15).toISOString(), payload: { toolCallId: "call-first", toolName: "read" } } } } },
    { payload: { metadata: { turnId: "first", event: { kind: "tool.completed", createdAt: new Date(17).toISOString(), payload: { toolCallId: "call-first", toolName: "read" } } } } },
    { payload: { metadata: { turnId: "last", event: { kind: "tool.started", createdAt: new Date(25).toISOString(), payload: { toolCallId: "call-last", toolName: "write" } } } } },
    { payload: { metadata: { turnId: "last", event: { kind: "tool.failed", createdAt: new Date(27).toISOString(), payload: { toolCallId: "call-last", toolName: "write" } } } } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  mkdirSync(arm.outputRoot, { recursive: true });
  const adapter = createButlerAdapter(async () => ({
    run: { dataRoot, workspaceRoot: arm.outputRoot },
    session: { id: "product-session" },
    providerRequests: [{ requestKind: "agent" }, { requestKind: "agent" }],
    observations: [
      { finalText: "first turn", providerReportedModel: "openai/gpt-5.5", timing: { submittedAtMs: 10, terminalAtMs: 20 }, turnId: "first" },
      { finalText: "last turn", providerReportedModel: "openai/gpt-5.5", timing: { submittedAtMs: 21, firstProviderTokenAtMs: 22, terminalAtMs: 30 }, turnId: "last", terminalState: "delivered" },
    ],
  }), root);
  expect((await adapter.preflight()).version).toBe("fixture-butler-1");
  const result = await adapter.run({ arm, fixture: AGENT_BENCHMARK_FIXTURES[0]!, prompt: "turn", sessionId: null, sourceEvidenceRoot: join(root, "evidence"), runtimeInstructions: "runtime", signal: new AbortController().signal });
  expect(result.finalText).toBe("last turn");
  expect(result.sessionId).toBe("product-session");
  expect(result.usage.modelRequests).toBe(2);
  expect(result.tools.calls).toBe(2);
  expect(result.tools.failedCalls).toBe(1);
  expect(result.timing.firstUsefulOutputAtMs).toBe(15);
  expect(result.adapterVersion).toBe("fixture-butler-1");
  expect(result.operations.userInterventions).toBe(0);
  expect(result.effectiveConfig?.model).toBe("openai/gpt-5.5");
});

test("Butler harness receives a nonexistent evidence root while external roots remain usable", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-evidence-lifecycle-"));
  try {
    const plan = createBenchmarkPlan({ runId: "evidence-lifecycle", seed: 15, runRoot: join(root, "run"), sourceRoot: process.cwd(), controlledModel: "openai/gpt-5.5" });
    const butlerArm = plan.arms.find((candidate) => candidate.agent === "butler" && candidate.scenario === "direct_conversation" && candidate.track === "controlled" && candidate.cache === "cold")!;
    prepareArmRoots(butlerArm);
    let evidenceRootExistedAtInvocation: boolean | null = null;
    const adapter = createButlerAdapter(async (input) => {
      evidenceRootExistedAtInvocation = existsSync(input.arm.evidenceRoot);
      return {
        run: { workspaceRoot: input.arm.outputRoot },
        session: { id: "fixture-session" },
        observations: [{ finalText: "fixture answer", providerReportedModel: input.arm.effectiveConfig.model, timing: { submittedAtMs: 1, terminalAtMs: 2 }, turnId: "turn-1" }],
        providerRequests: [],
      };
    }, process.cwd());
    const result = await adapter.run({ arm: butlerArm, fixture: AGENT_BENCHMARK_FIXTURES[0]!, prompt: "turn", sessionId: null, sourceEvidenceRoot: "", runtimeInstructions: "runtime", signal: new AbortController().signal });
    expect(evidenceRootExistedAtInvocation === false).toBe(true);
    expect(result.gateCode).toBe("none");

    const hermesArm = plan.arms.find((candidate) => candidate.agent === "hermes" && candidate.scenario === "current_web_research" && candidate.track === "controlled" && candidate.cache === "cold")!;
    prepareArmRoots(hermesArm);
    expect(existsSync(hermesArm.evidenceRoot)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Butler adapter cleans ephemeral runtime data after successful and failed harness evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-runtime-cleanup-"));
  try {
    const plan = createBenchmarkPlan({ runId: "runtime-cleanup", seed: 55, runRoot: join(root, "run"), sourceRoot: process.cwd(), controlledModel: "openai/gpt-5.5" });
    const arm = plan.arms.find((candidate) => candidate.agent === "butler" && candidate.scenario === "direct_conversation" && candidate.track === "controlled" && candidate.cache === "cold")!;
    mkdirSync(arm.outputRoot, { recursive: true });
    for (const failed of [false, true]) {
      const adapter = createButlerAdapter(async (input) => {
        mkdirSync(input.arm.evidenceRoot, { recursive: true });
        const dataRoot = join(input.arm.evidenceRoot, "data");
        mkdirSync(dataRoot, { recursive: true });
        writeFileSync(join(dataRoot, "runtime.db"), "ephemeral", "utf8");
        const evidence = {
          ok: !failed,
          ...(failed ? { error: "harness failed" } : {}),
          run: { dataRoot, workspaceRoot: input.arm.outputRoot },
          session: { id: "fixture-session" },
          observations: failed ? [] : [{ finalText: "fixture answer", providerReportedModel: input.arm.effectiveConfig.model, timing: { submittedAtMs: 1, terminalAtMs: 2 }, turnId: "turn-1" }],
          providerRequests: [],
        };
        writeFileSync(join(input.arm.evidenceRoot, "evidence.json"), JSON.stringify(evidence), "utf8");
        if (failed) throw new Error("harness failed");
        return evidence;
      }, process.cwd());
      const result = await adapter.run({ arm, fixture: AGENT_BENCHMARK_FIXTURES[0]!, prompt: "turn", sessionId: null, sourceEvidenceRoot: "", runtimeInstructions: "runtime", signal: new AbortController().signal });
      expect(existsSync(join(arm.evidenceRoot, "data"))).toBe(false);
      expect(existsSync(join(arm.evidenceRoot, "evidence.json"))).toBe(true);
      expect(result.exitCode).toBe(failed ? 1 : 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Butler runtime cleanup fails closed for out-of-root and symlink data paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-runtime-cleanup-boundary-"));
  try {
    const plan = createBenchmarkPlan({ runId: "runtime-cleanup-boundary", seed: 56, runRoot: join(root, "run"), sourceRoot: process.cwd(), controlledModel: "openai/gpt-5.5" });
    const arm = plan.arms.find((candidate) => candidate.agent === "butler" && candidate.scenario === "direct_conversation" && candidate.track === "controlled" && candidate.cache === "cold")!;
    mkdirSync(arm.outputRoot, { recursive: true });
    const outside = join(root, "outside-data");
    const symlinkTarget = join(arm.evidenceRoot, "data-link");
    for (const dataRoot of [outside, symlinkTarget]) {
      const adapter = createButlerAdapter(async (input) => {
        mkdirSync(input.arm.evidenceRoot, { recursive: true });
        mkdirSync(outside, { recursive: true });
        writeFileSync(join(outside, "keep.txt"), "keep", "utf8");
        if (dataRoot === symlinkTarget) symlinkSync(outside, symlinkTarget, "dir");
        const evidence = {
          ok: true,
          run: { dataRoot, workspaceRoot: input.arm.outputRoot },
          session: { id: "fixture-session" },
          observations: [{ finalText: "fixture answer", providerReportedModel: input.arm.effectiveConfig.model, timing: { submittedAtMs: 1, terminalAtMs: 2 }, turnId: "turn-1" }],
          providerRequests: [],
        };
        return evidence;
      }, process.cwd());
      const result = await adapter.run({ arm, fixture: AGENT_BENCHMARK_FIXTURES[0]!, prompt: "turn", sessionId: null, sourceEvidenceRoot: "", runtimeInstructions: "runtime", signal: new AbortController().signal });
      expect(result.gateCode).toBe("configuration_unverifiable");
      expect(evaluateAdapterResult(arm, AGENT_BENCHMARK_FIXTURES[0]!, result).terminalState).toBe("gated");
      expect(existsSync(join(outside, "keep.txt"))).toBe(true);
      if (dataRoot === symlinkTarget) expect(existsSync(symlinkTarget)).toBe(true);
      if (dataRoot === symlinkTarget) rmSync(symlinkTarget, { force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Butler landing artifact copy includes extra generated assets but excludes input namespace", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-artifacts-"));
  const plan = createBenchmarkPlan({ runId: "artifacts", seed: 36, runRoot: join(root, "run"), sourceRoot: join(root, "source"), controlledModel: "openai/gpt-5.5" });
  const arm = plan.arms.find((candidate) => candidate.agent === "butler" && candidate.scenario === "butler_landing_page")!;
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, ".benchmark-input", "repository"), { recursive: true });
  writeFileSync(join(workspace, "index.html"), "index", "utf8");
  writeFileSync(join(workspace, "styles.css"), "styles", "utf8");
  writeFileSync(join(workspace, "README.md"), "readme", "utf8");
  writeFileSync(join(workspace, "package.json"), "{}", "utf8");
  writeFileSync(join(workspace, "app.js"), "asset", "utf8");
  writeFileSync(join(workspace, ".benchmark-input", "repository", "README.md"), "pinned", "utf8");
  copyGeneratedArtifacts({ run: { workspaceRoot: workspace } }, { arm, fixture: AGENT_BENCHMARK_FIXTURES.find((fixture) => fixture.id === "butler_landing_page")! });
  expect(await (await import("node:fs/promises")).readFile(join(arm.outputRoot, "app.js"), "utf8")).toBe("asset");
  expect(existsSync(join(arm.outputRoot, ".benchmark-input"))).toBe(false);
});

test("workflow persists terminal arms and resumes without re-running them", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-test-"));
  const sourceRoot = join(root, "source");
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(join(sourceRoot, "package.json"), '{"name":"fixture-source"}', "utf8");
  writeFileSync(join(sourceRoot, "README.md"), "Butler fixture evidence", "utf8");
  const plan = createBenchmarkPlan({
    runId: "resume-test",
    seed: 7,
    runRoot: join(root, "run"),
    sourceRoot,
    controlledModel: "openai/gpt-5.5",
  });
  const calls: string[] = [];
  const adapters = {
    butler: fakeAdapter(calls, "butler"),
    hermes: fakeAdapter(calls, "hermes"),
    opencode: fakeAdapter(calls, "opencode"),
  } as const;
  const store = createFileCheckpointStore(join(plan.runRoot, "result.json"));
  const landingValidator = async () => ({
    buildPassed: true,
    testPassed: true,
    browserAvailable: true,
    desktop: { loaded: true, overflowFree: true, screenshotRef: "desktop.png" },
    mobile: { loaded: true, overflowFree: true, screenshotRef: "mobile.png" },
    visualQuality: null,
    diagnostics: [],
  });
  const first = await runAgentBenchmark({ plan, adapters, store, signal: new AbortController().signal, landingValidator, mode: "execute" });
  expect(first.result.observations).toHaveLength(plan.arms.length);
  const callsAfterFirst = calls.length;
  const second = await runAgentBenchmark({ plan, adapters, store, signal: new AbortController().signal, landingValidator, mode: "execute" });
  expect(calls.length).toBe(callsAfterFirst);
  expect(second.result.run.state).toBe("reported");
});

test("report summary with a gate never becomes rank eligible", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-summary-"));
  const plan = createBenchmarkPlan({
    runId: "summary-test",
    seed: 9,
    runRoot: join(root, "run"),
    sourceRoot: join(root, "source"),
    controlledModel: "openai/gpt-5.5",
  });
  const observations = plan.arms.slice(0, 3).map((arm) => ({
    arm,
    terminalState: "gated" as const,
    gateCode: "executable_missing" as const,
  }));
  const summary = summarizeBenchmarkResult({
    schema: "butler.agent-benchmark.v1",
    kind: "agent_benchmark_result",
    run: { runId: plan.runId, seed: plan.seed, baselineSha: plan.baselineSha, runRoot: plan.runRoot, state: "reported" },
    plan,
    observations: observations.map((value) => ({
      ...emptyObservation(value.arm),
      terminalState: value.terminalState,
      gateCode: value.gateCode,
    })),
  });
  expect(summary.canRank).toBe(false);
  expect(summary.gatedAgents.length).toBeGreaterThan(0);
});

test("report truthfully distinguishes complete all-rejected results from missing or gated runs", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-report-rejected-"));
  const plan = createBenchmarkPlan({ runId: "report-rejected", seed: 45, runRoot: join(root, "run"), sourceRoot: join(root, "source"), controlledModel: "openai/gpt-5.6-sol" });
  const observations = plan.arms.map((arm) => ({
    ...emptyObservation(arm),
    terminalState: "rejected" as const,
    gateCode: "none" as const,
    evaluation: { ...emptyObservation(arm).evaluation, accepted: false },
    acceptedResultPerToken: null,
  }));
  const result = { schema: "butler.agent-benchmark.v1" as const, kind: "agent_benchmark_result" as const, run: { runId: plan.runId, seed: plan.seed, baselineSha: plan.baselineSha, runRoot: plan.runRoot, state: "reported" as const }, plan, observations };
  const summary = summarizeBenchmarkResult(result);
  expect(summary.canRank).toBe(false);
  const markdown = generateBenchmarkReport(result);
  expect(markdown).toContain("Ranking: withheld (no observation met acceptance criteria)");
  expect(markdown).toContain("No observation met the acceptance criteria.");
  expect(markdown).not.toContain("installation or another required observation is unavailable");
});

test("report ranking requires every planned arm and known token efficiency", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-rank-"));
  const plan = createBenchmarkPlan({ runId: "rank-all", seed: 16, runRoot: join(root, "run"), sourceRoot: join(root, "source"), controlledModel: "openai/gpt-5.5" });
  const observations = plan.arms.map((arm) => ({
    ...emptyObservation(arm),
    terminalState: "accepted" as const,
    evaluation: { ...emptyObservation(arm).evaluation, accepted: true },
    usage: { ...emptyObservation(arm).usage, totalTokens: 100 },
    acceptedResultPerToken: 10_000,
  }));
  observations[0] = { ...observations[0]!, usage: { ...observations[0]!.usage, totalTokens: null }, acceptedResultPerToken: null } as unknown as typeof observations[number];
  const summary = summarizeBenchmarkResult({ schema: "butler.agent-benchmark.v1", kind: "agent_benchmark_result", run: { runId: plan.runId, seed: plan.seed, baselineSha: plan.baselineSha, runRoot: plan.runRoot, state: "reported" }, plan, observations });
  expect(summary.arms).toHaveLength(plan.arms.length);
  expect(summary.canRank).toBe(false);
  const markdown = generateBenchmarkReport({ schema: "butler.agent-benchmark.v1", kind: "agent_benchmark_result", run: { runId: plan.runId, seed: plan.seed, baselineSha: plan.baselineSha, runRoot: plan.runRoot, state: "reported" }, plan, observations });
  expect(markdown).toContain("butler: model=");
  expect(markdown).toContain("hermes: model=");
  expect(markdown).toContain("hermes: model=openai/gpt-5.5, reasoning=medium, provider=openai-codex");
  expect(markdown).toContain("Recommended-default: butler: not present; hermes: not present; opencode: not present");
});

test("report ranking waits for typed visual review on every landing arm", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-visual-rank-"));
  const plan = createBenchmarkPlan({ runId: "visual-rank", seed: 17, runRoot: join(root, "run"), sourceRoot: join(root, "source"), controlledModel: "openai/gpt-5.5" });
  const observations = plan.arms.map((arm) => ({
    ...emptyObservation(arm),
    terminalState: "accepted" as const,
    evaluation: { ...emptyObservation(arm).evaluation, accepted: true },
    usage: { ...emptyObservation(arm).usage, totalTokens: 100 },
    acceptedResultPerToken: 10_000,
  })) as unknown as BenchmarkObservation[];
  const result = (values: BenchmarkObservation[]) => summarizeBenchmarkResult({
    schema: "butler.agent-benchmark.v1",
    kind: "agent_benchmark_result",
    run: { runId: plan.runId, seed: plan.seed, baselineSha: plan.baselineSha, runRoot: plan.runRoot, state: "reported" },
    plan,
    observations: values,
  });
  expect(result(observations).canRank).toBe(false);
  const reviewed = observations.map((observation) => observation.arm.scenario !== "butler_landing_page"
    ? observation
    : {
        ...observation,
        visualReview: { score: 4, reviewerLabel: "reviewer-1", rubricVersion: "landing-rubric-v1" },
        evaluation: { ...observation.evaluation, visualQuality: 4 },
      });
  expect(result(reviewed).canRank).toBe(true);
});

test("group medians stay unknown when any planned repetition is missing a metric", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-median-unknown-"));
  const plan = createBenchmarkPlan({ runId: "median-unknown", seed: 33, runRoot: join(root, "run"), sourceRoot: join(root, "source"), controlledModel: "openai/gpt-5.5" });
  const first = plan.arms.find((arm) => arm.agent === "butler" && arm.scenario === "direct_conversation" && arm.track === "controlled" && arm.cache === "cold")!;
  const second = {
    ...first,
    key: `${first.key}:synthetic-repetition`,
    repetition: 2,
    order: first.order + plan.arms.length,
    cachePairId: `${first.cachePairId}:synthetic-repetition`,
    outputRoot: `${first.outputRoot}-synthetic-repetition`,
    dataRoot: `${first.dataRoot}-synthetic-repetition`,
    evidenceRoot: `${first.evidenceRoot}-synthetic-repetition`,
  };
  const medianPlan = { ...plan, arms: [first, second] };
  const observations = [first, second].map((arm, index) => ({
    ...emptyObservation(arm),
    usage: { ...emptyObservation(arm).usage, totalTokens: index === 0 ? 100 : null },
    timing: { ...emptyObservation(arm).timing, totalElapsedMs: index === 0 ? 10 : null },
  }));
  const summary = summarizeBenchmarkResult({ schema: "butler.agent-benchmark.v1", kind: "agent_benchmark_result", run: { runId: plan.runId, seed: plan.seed, baselineSha: plan.baselineSha, runRoot: plan.runRoot, state: "reported" }, plan: medianPlan, observations });
  const median = summary.medians.find((value) => value.agent === "butler" && value.scenario === "direct_conversation" && value.track === "controlled" && value.cache === "cold");
  expect(median?.totalTokens).toBeNull();
  expect(median?.elapsedMs).toBeNull();
});

test("external direct conversation uses one real session and sequential argv turns", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-cli-adapter-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const logPath = join(root, "argv.log");
  const script = join(bin, "hermes");
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${logPath}\ncase "$1" in\n  --version) echo 'hermes 1.0';;\n  auth) echo 'nous configured';;\n  config) if [ "$3" = "agent.reasoning_effort" ]; then echo '"medium"'; else echo '{"default":"gpt-5.6-sol","provider":"openai-codex","base_url":""}'; fi;;\n  *) echo 'session_id: real-session' >&2; echo 'turn';;\nesac\n`, "utf8");
  chmodSync(script, 0o755);
  const previousPath = process.env.PATH;
  const previousHome = process.env.HOME;
  process.env.PATH = bin;
  process.env.HOME = root;
  mkdirSync(join(root, ".hermes"), { recursive: true });
  writeFileSync(join(root, ".hermes", "auth.json"), "{}", "utf8");
  const db = new Database(join(root, ".hermes", "state.db"));
  db.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, billing_provider TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, api_call_count INTEGER, tool_call_count INTEGER)");
  db.run("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", ["real-session", "gpt-5.6-sol", "openai-codex", 40, 32, 8, 4, 4, 2]);
  db.close();
  try {
    const plan = createBenchmarkPlan({ runId: "adapter", seed: 4, runRoot: join(root, "run"), sourceRoot: join(root, "source"), controlledModel: "openai/gpt-5.5" });
    const arm = plan.arms.find((candidate) => candidate.agent === "hermes" && candidate.scenario === "direct_conversation" && candidate.cache === "cold" && candidate.track === "controlled")!;
    mkdirSync(arm.outputRoot, { recursive: true });
    const adapter = new ExternalCliAdapter("hermes", { execute: executeCommand });
    const preflight = await adapter.preflight();
    expect(preflight.gateCode).toBe("none");
    expect(preflight.effectiveConfig).toMatchObject({ model: "gpt-5.6-sol", provider: "openai-codex", reasoning: "medium" });
    const result = await adapter.run({ arm, fixture: AGENT_BENCHMARK_FIXTURES[0]!, prompt: AGENT_BENCHMARK_FIXTURES[0]!.prompts.join("\n"), sessionId: null, sourceEvidenceRoot: join(root, "evidence"), runtimeInstructions: "runtime", signal: new AbortController().signal });
    expect(result.gateCode).toBe("none");
    expect(result.sessionId).toBe("real-session");
    expect(result.adapterVersion).toBe("hermes 1.0");
    expect(result.effectiveConfig?.model).toBe("gpt-5.6-sol");
    expect(result.effectiveConfig?.provider).toBe("openai-codex");
    expect(result.effectiveConfig?.reasoning).toBe("medium");
    expect(result.usage).toMatchObject({ inputTokens: 40, cacheReadTokens: 8, cacheWriteTokens: 4, outputTokens: 32, totalTokens: 72, modelRequests: 4 });
    const calls = await (await import("node:fs/promises")).readFile(logPath, "utf8");
    const callLines = calls.split("\n").filter(Boolean);
    const turnLines = callLines.filter((line) => line.startsWith("chat "));
    expect(turnLines.length).toBe(4);
    expect(turnLines.filter((line) => line.includes(" -q ")).length).toBe(4);
    expect(calls).toContain("--resume real-session");
  } finally {
    process.env.PATH = previousPath;
    process.env.HOME = previousHome;
  }
});

test("external direct conversation gates when a resumed turn changes the real session", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-session-mismatch-"));
  const plan = createBenchmarkPlan({ runId: "session-mismatch", seed: 32, runRoot: join(root, "run"), sourceRoot: join(root, "source"), controlledModel: "openai/gpt-5.5" });
  const arm = plan.arms.find((candidate) => candidate.agent === "opencode" && candidate.scenario === "direct_conversation" && candidate.cache === "cold" && candidate.track === "controlled")!;
  mkdirSync(arm.outputRoot, { recursive: true });
  let calls = 0;
  const adapter = new ExternalCliAdapter("opencode", { execute: async (_request) => {
    calls += 1;
    return { exitCode: 0, stdout: JSON.stringify({ sessionID: `session-${calls}`, text: "turn" }), stderr: "", startedAtMs: calls, endedAtMs: calls + 1, firstOutputAtMs: calls, timedOut: false, cancelled: false };
  } });
  const result = await adapter.run({ arm, fixture: AGENT_BENCHMARK_FIXTURES[0]!, prompt: "turn", sessionId: null, sourceEvidenceRoot: "", runtimeInstructions: "runtime", signal: new AbortController().signal });
  expect(result.gateCode).toBe("measurement_unavailable");
});

test("web evaluator requires the frozen Bun answer and both official URLs", () => {
  const fixture = AGENT_BENCHMARK_FIXTURES.find((candidate) => candidate.id === "current_web_research")!;
  const correct = "Bun v1.3.14 was published May 13 2026. The release includes built-in Bun.Image. Publication date is distinct from the event date. https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14 https://bun.com/blog/bun-v1.3.14";
  expect(evaluateWebResearch(correct, fixture).accepted).toBe(true);
  expect(evaluateWebResearch(correct.replace("1.3.14", "1.3.13"), fixture).accepted).toBe(false);
  expect(evaluateWebResearch(correct.replace("https://bun.com/blog/bun-v1.3.14", "https://example.com"), fixture).accepted).toBe(false);
});

test("OpenCode JSON events capture nested tool parts and a real session id", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-opencode-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const logPath = join(root, "argv.log");
  const script = join(bin, "opencode");
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${logPath}\ncase "$1" in\n  --version) echo 'opencode 1.0';;\n  auth) echo 'provider configured';;\n  *) echo '{"sessionID":"oc-session","part":{"type":"tool","name":"filesystem"},"text":"turn"}';;\nesac\n`, "utf8");
  chmodSync(script, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    const plan = createBenchmarkPlan({ runId: "opencode-adapter", seed: 5, runRoot: join(root, "run"), sourceRoot: join(root, "source"), controlledModel: "openai/gpt-5.5" });
    const arm = plan.arms.find((candidate) => candidate.agent === "opencode" && candidate.scenario === "direct_conversation" && candidate.cache === "cold" && candidate.track === "controlled")!;
    mkdirSync(arm.outputRoot, { recursive: true });
    const adapter = new ExternalCliAdapter("opencode", { execute: executeCommand });
    expect((await adapter.preflight()).gateCode).toBe("none");
    const result = await adapter.run({ arm, fixture: AGENT_BENCHMARK_FIXTURES[0]!, prompt: AGENT_BENCHMARK_FIXTURES[0]!.prompts.join("\n"), sessionId: null, sourceEvidenceRoot: join(root, "evidence"), runtimeInstructions: "runtime", signal: new AbortController().signal });
    expect(result.gateCode).toBe("none");
    expect(result.tools.calls).toBeGreaterThan(0);
    expect((await (await import("node:fs/promises")).readFile(logPath, "utf8"))).toContain("--session oc-session");
  } finally {
    process.env.PATH = previousPath;
  }
});

test("CLI parser deduplicates identified usage events and lifecycle tool parts", () => {
  const parsed = parseCliOutput("opencode", [
    JSON.stringify({ sessionID: "session-1", requestId: "request-1", usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 }, type: "tool.started", part: { type: "tool.started", callID: "call-1", name: "read" } }),
    JSON.stringify({ timestamp: 123, requestId: "request-2", usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 }, type: "text", text: "answer" }),
    JSON.stringify({ requestId: "request-2", usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 }, type: "step.updated" }),
    JSON.stringify({ type: "tool.completed", part: { type: "tool.completed", callID: "call-1", name: "read" } }),
  ].join("\n"), 123);
  expect(parsed.sessionId).toBe("session-1");
  expect(parsed.usage.inputTokens).toBe(6);
  expect(parsed.usage.totalTokens).toBe(14);
  expect(parsed.tools.calls).toBe(1);
  expect(parsed.firstUsefulOutputAtMs).toBe(123);
});

test("OpenCode official step-finish and tool-use parts preserve usage, timing, and one lifecycle call", () => {
  const parsed = parseCliOutput("opencode", [
    JSON.stringify({ timestamp: 100, sessionID: "official-session", part: { type: "step-start", messageID: "message-1" } }),
    JSON.stringify({ timestamp: 140, sessionID: "official-session", part: { type: "text", text: "answer", messageID: "message-1" } }),
    JSON.stringify({ timestamp: 150, sessionID: "official-session", type: "tool_use", part: { type: "tool", callID: "call-1", tool: "read", state: { status: "running", time: { start: 150 } } } }),
    JSON.stringify({ timestamp: 160, sessionID: "official-session", type: "tool_use", part: { type: "tool", callID: "call-1", tool: "read", state: { status: "completed", time: { start: 150, end: 160 } } } }),
    JSON.stringify({ timestamp: 170, sessionID: "official-session", part: { type: "step-finish", id: "part-1", messageID: "message-1", tokens: { input: 11, output: 7, total: 18, cache: { read: 3, write: 2 } } } }),
    JSON.stringify({ timestamp: 180, sessionID: "official-session", part: { type: "step-finish", id: "part-2", messageID: "message-1", tokens: { input: 5, output: 4, total: 9, cache: { read: 1, write: 0 } } } }),
  ].join("\n"), 90);
  expect(parsed.sessionId).toBe("official-session");
  expect(parsed.firstUsefulOutputAtMs).toBe(140);
  expect(parsed.usage).toMatchObject({ inputTokens: 16, outputTokens: 11, totalTokens: 27, cacheReadTokens: 4, cacheWriteTokens: 2, modelRequests: 2 });
  expect(parsed.tools.calls).toBe(1);
  expect(parsed.tools.failedCalls).toBe(0);
  expect(parsed.tools.records?.[0]).toMatchObject({ callId: "call-1", name: "read", status: "completed", startedAtMs: 150, endedAtMs: 160 });
});

test("Hermes plain quiet output does not fabricate tool telemetry", () => {
  const parsed = parseCliOutput("hermes", "A useful answer", 123);
  expect(parsed.tools.calls).toBeNull();
  expect(parsed.tools.failedCalls).toBeNull();
});

test("Hermes plain output captures session_id metadata without treating it as the answer", () => {
  const parsed = parseCliOutput("hermes", "session_id: 2026-session_1\nA useful answer", 123);
  expect(parsed.sessionId).toBe("2026-session_1");
  expect(parsed.finalText).toBe("A useful answer");
  expect(parseCliOutput("hermes", "Session ID: 2026-session_1", 123).finalText).toBeNull();
  expect(parseCliOutput("opencode", JSON.stringify({ sessionID: "/Users/private/session", text: "answer" })).sessionId).toBeNull();
  expect(parseCliOutput("hermes", `session_id: ${"a".repeat(161)}\nA useful answer`, 123).sessionId).toBeNull();
  expect(parseCliOutput("hermes", "A useful answer", 123, "session_id: stderr-session").sessionId).toBe("stderr-session");
});

test("OpenCode step-finish usage without unique part ids is unknown", () => {
  const parsed = parseCliOutput("opencode", [
    JSON.stringify({ part: { type: "step-finish", messageID: "same", tokens: { input: 2, output: 3, total: 5 } } }),
    JSON.stringify({ part: { type: "step-finish", messageID: "same", tokens: { input: 4, output: 5, total: 9 } } }),
  ].join("\n"));
  expect(parsed.usage.totalTokens).toBeNull();
  expect(parsed.usage.modelRequests).toBeNull();
});

test("CLI parser fails closed when multiple usage events have no request identity", () => {
  const parsed = parseCliOutput("opencode", [
    JSON.stringify({ usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 }, text: "one" }),
    JSON.stringify({ usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 }, text: "two" }),
  ].join("\n"));
  expect(parsed.usage.totalTokens).toBeNull();
  expect(parsed.usage.inputTokens).toBeNull();
});

test("evaluator preserves an explicitly unknown tool count", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-tool-unknown-"));
  const plan = createBenchmarkPlan({ runId: "tool-unknown", seed: 21, runRoot: join(root, "run"), sourceRoot: join(root, "source"), controlledModel: "openai/gpt-5.5" });
  const arm = plan.arms.find((candidate) => candidate.agent === "opencode" && candidate.scenario === "direct_conversation")!;
  const observation = evaluateAdapterResult(arm, AGENT_BENCHMARK_FIXTURES[0]!, baseAdapterResult({ tools: { calls: null, failedCalls: null, records: [{ name: "first", status: "unknown", startedAtMs: null, endedAtMs: null }, { name: "second", status: "unknown", startedAtMs: null, endedAtMs: null }] } }));
  expect(observation.tools.calls).toBeNull();
  expect(observation.tools.failedCalls).toBeNull();
});

test("accepted-result-per-token uses a complete input/output-derived total", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-derived-total-"));
  const plan = createBenchmarkPlan({ runId: "derived-total", seed: 24, runRoot: join(root, "run"), sourceRoot: join(root, "source"), controlledModel: "openai/gpt-5.5" });
  const arm = plan.arms.find((candidate) => candidate.agent === "butler" && candidate.scenario === "current_web_research" && candidate.track === "controlled")!;
  const fixture = AGENT_BENCHMARK_FIXTURES.find((candidate) => candidate.id === "current_web_research")!;
  const observation = evaluateAdapterResult(arm, fixture, baseAdapterResult({
    finalText: "Bun v1.3.14 was published May 13 2026. It includes built-in Bun.Image. Publication date is distinct from the event date. https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14 https://bun.com/blog/bun-v1.3.14",
    usage: { inputTokens: 10, outputTokens: 10, totalTokens: null, modelRequests: 1 },
  }));
  expect(observation.terminalState).toBe("accepted");
  expect(observation.usage.totalTokens).toBe(20);
  expect(observation.acceptedResultPerToken).toBe(50_000);
});

test("direct synthesis evaluator accepts equivalent English and Korean claims but fails closed per omission", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-direct-eval-"));
  const plan = createBenchmarkPlan({ runId: "direct-eval", seed: 25, runRoot: join(root, "run"), sourceRoot: join(root, "source"), controlledModel: "openai/gpt-5.5" });
  const arm = plan.arms.find((candidate) => candidate.agent === "butler" && candidate.scenario === "direct_conversation" && candidate.track === "controlled" && candidate.cache === "cold")!;
  const fixture = AGENT_BENCHMARK_FIXTURES.find((candidate) => candidate.id === "direct_conversation")!;
  const english = "A reproducible benchmark pins inputs and records the environment. Confounding variables are controlled by holding the model and cache constant. Unavailable tools and measurements are gated and remain unknown, never counted as zero.";
  const korean = "재현 가능한 벤치마크는 입력과 실행 환경을 고정하고 기록합니다. 비교의 교란 변수는 모델과 캐시를 동일하게 유지해 통제합니다. 사용할 수 없는 도구와 측정값은 게이트 처리하며 미확인으로 남기고 0으로 세지 않습니다.";
  const equivalentKorean = "조건을 고정하고 입력과 실행 환경 및 평가 절차를 동일하게 유지합니다. 비교의 교란 변수는 모델과 캐시를 동일하게 유지해 통제합니다. 사용할 수 없는 도구와 측정값은 게이트 처리하며 미확인으로 남기고 0으로 세지 않습니다.";
  for (const finalText of [english, korean, equivalentKorean]) {
    const observation = evaluateAdapterResult(arm, fixture, baseAdapterResult({ finalText }));
    expect(observation.evaluation.factualAccuracy).toBe(1);
    expect(observation.evaluation.accepted).toBe(true);
  }
  const nearMiss = "입력과 실행 환경 및 평가 절차를 기록하고 설명합니다. 비교의 교란 변수는 모델과 캐시를 동일하게 유지해 통제합니다. 사용할 수 없는 도구와 측정값은 게이트 처리하며 미확인으로 남기고 0으로 세지 않습니다.";
  const nearMissObservation = evaluateAdapterResult(arm, fixture, baseAdapterResult({ finalText: nearMiss }));
  expect(nearMissObservation.evaluation.factualAccuracy).toBeLessThan(1);
  expect(nearMissObservation.evaluation.accepted).toBe(false);
  const omissions = [
    english.replace("pins inputs and records the environment", "uses a benchmark"),
    english.replace("Confounding variables are controlled by holding the model and cache constant.", "The model and cache are documented."),
    english.replace("Unavailable tools and measurements are gated and remain unknown, never counted as zero.", "Unavailable tools are mentioned."),
  ];
  for (const finalText of omissions) {
    const observation = evaluateAdapterResult(arm, fixture, baseAdapterResult({ finalText }));
    expect(observation.evaluation.factualAccuracy).toBeLessThan(1);
    expect(observation.evaluation.accepted).toBe(false);
  }
  for (const falseStatement of [
    english.replace("Unavailable tools and measurements are gated and remain unknown, never counted as zero.", "Unavailable tools and measurements count as zero."),
    korean.replace("사용할 수 없는 도구와 측정값은 게이트 처리하며 미확인으로 남기고 0으로 세지 않습니다.", "사용할 수 없는 도구와 측정값을 0으로 계산합니다."),
  ]) {
    const observation = evaluateAdapterResult(arm, fixture, baseAdapterResult({ finalText: falseStatement }));
    expect(observation.evaluation.factualAccuracy).toBeLessThan(1);
    expect(observation.evaluation.accepted).toBe(false);
  }
});

test("external preflight does not infer authentication from a successful empty listing", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-auth-gate-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "opencode");
  writeFileSync(script, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo opencode; elif [ \"$1\" = \"auth\" ]; then exit 0; fi\n", "utf8");
  chmodSync(script, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    const adapter = new ExternalCliAdapter("opencode", { execute: executeCommand });
    const result = await adapter.preflight();
    expect(result.available).toBe(false);
    expect(result.gateCode).toBe("authentication_unavailable");
    expect(result.authenticated).toBe(false);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("external preflight rejects negative official auth listings", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-auth-negative-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "hermes");
  writeFileSync(script, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo hermes; elif [ \"$1\" = \"auth\" ]; then echo 'No credentials found'; fi\n", "utf8");
  chmodSync(script, 0o755);
  const previousPath = process.env.PATH;
  const previousHome = process.env.HOME;
  process.env.PATH = bin;
  process.env.HOME = root;
  try {
    const result = await new ExternalCliAdapter("hermes", { execute: executeCommand }).preflight();
    expect(result.authenticated).toBe(false);
    expect(result.gateCode).toBe("authentication_unavailable");
  } finally {
    process.env.PATH = previousPath;
    process.env.HOME = previousHome;
  }
});

test("OpenCode auth list with not-configured text is a gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-opencode-auth-negative-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "opencode");
  writeFileSync(script, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo opencode; elif [ \"$1\" = \"auth\" ]; then echo 'provider not configured'; fi\n", "utf8");
  chmodSync(script, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    const result = await new ExternalCliAdapter("opencode", { execute: executeCommand }).preflight();
    expect(result.authenticated).toBe(false);
    expect(result.gateCode).toBe("authentication_unavailable");
  } finally {
    process.env.PATH = previousPath;
  }
});

test("OpenCode controlled preflight gates when the normal auth data root is unverifiable", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-opencode-auth-root-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "opencode");
  writeFileSync(script, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo opencode; else echo 'provider configured'; fi\n", "utf8");
  chmodSync(script, 0o755);
  const previousPath = process.env.PATH;
  const previousHome = process.env.HOME;
  const previousXdgData = process.env.XDG_DATA_HOME;
  process.env.PATH = bin;
  process.env.HOME = join(root, "missing-home");
  delete process.env.XDG_DATA_HOME;
  try {
    const result = await new ExternalCliAdapter("opencode", { execute: executeCommand }).preflight();
    expect(result.available).toBe(false);
    expect(result.authenticated).toBeNull();
    expect(result.gateCode).toBe("configuration_unverifiable");
    const symlinkHome = join(root, "symlink-home");
    const symlinkData = join(symlinkHome, ".local", "share", "opencode");
    const symlinkTarget = join(root, "auth-target.json");
    mkdirSync(symlinkData, { recursive: true });
    writeFileSync(symlinkTarget, "{}", "utf8");
    symlinkSync(symlinkTarget, join(symlinkData, "auth.json"));
    process.env.HOME = symlinkHome;
    const symlinkResult = await new ExternalCliAdapter("opencode", { execute: executeCommand }).preflight();
    expect(symlinkResult.gateCode).toBe("configuration_unverifiable");
  } finally {
    process.env.PATH = previousPath;
    process.env.HOME = previousHome;
    if (previousXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdgData;
  }
});

test("external OpenCode controlled arms isolate legacy config while retaining normal auth data and paired cache", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-external-cache-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const normalHome = join(root, "normal-home");
  const normalDataRoot = join(normalHome, ".local", "share");
  mkdirSync(join(normalHome, ".opencode"), { recursive: true });
  mkdirSync(join(normalDataRoot, "opencode"), { recursive: true });
  writeFileSync(join(normalHome, ".opencode", "legacy-marker"), "normal-config", "utf8");
  writeFileSync(join(normalDataRoot, "opencode", "auth.json"), "{}", "utf8");
  writeFileSync(join(bin, "opencode"), "#!/bin/sh\nif [ -f \"$HOME/.opencode/legacy-marker\" ]; then legacy=legacy-visible; else legacy=legacy-hidden; fi\nprintf '%s|%s|%s|%s|%s|%s|%s\\n' \"$HOME\" \"${OPENCODE_CONFIG_CONTENT-}\" \"${XDG_CONFIG_HOME-}\" \"${OPENCODE_CONFIG_DIR-}\" \"${XDG_DATA_HOME-}\" \"${XDG_CACHE_HOME-}\" \"$legacy\" >> \"$BUTLER_DATA\"\nif [ \"$1\" = \"--version\" ]; then echo opencode; else echo '{\"sessionID\":\"session\",\"model\":\"openai/gpt-5.5\",\"text\":\"turn\"}'; fi\n", "utf8");
  chmodSync(join(bin, "opencode"), 0o755);
  const previousPath = process.env.PATH;
  const previousLog = process.env.BUTLER_DATA;
  const previousHome = process.env.HOME;
  const previousXdgData = process.env.XDG_DATA_HOME;
  process.env.PATH = bin;
  process.env.BUTLER_DATA = join(root, "home.log");
  process.env.HOME = normalHome;
  process.env.XDG_DATA_HOME = normalDataRoot;
  const plan = createBenchmarkPlan({ runId: "external-cache", seed: 14, runRoot: join(root, "run"), sourceRoot: join(root, "source"), controlledModel: "openai/gpt-5.5" });
  const adapter = new ExternalCliAdapter("opencode", { execute: executeCommand });
  const controlled = plan.arms.find((arm) => arm.agent === "opencode" && arm.cache === "cold" && arm.track === "controlled")!;
  const warm = plan.arms.find((arm) => arm.agent === "opencode" && arm.cache === "warm" && arm.track === "controlled")!;
  const recommended = recommendedArmFrom(controlled);
  mkdirSync(controlled.outputRoot, { recursive: true });
  mkdirSync(warm.outputRoot, { recursive: true });
  mkdirSync(recommended.outputRoot, { recursive: true });
  const fixture = AGENT_BENCHMARK_FIXTURES[1]!;
  const controlledResult = await adapter.run({ arm: controlled, fixture, prompt: "turn", sessionId: null, sourceEvidenceRoot: join(root, "evidence"), runtimeInstructions: "runtime", signal: new AbortController().signal });
  const warmResult = await adapter.run({ arm: warm, fixture, prompt: "turn", sessionId: null, sourceEvidenceRoot: join(root, "evidence"), runtimeInstructions: "runtime", signal: new AbortController().signal });
  const recommendedResult = await adapter.run({ arm: recommended, fixture, prompt: "turn", sessionId: null, sourceEvidenceRoot: join(root, "evidence"), runtimeInstructions: "runtime", signal: new AbortController().signal });
  expect(controlledResult.gateCode).toBe("none");
  expect(warmResult.gateCode).toBe("none");
  expect(recommendedResult.gateCode).toBe("none");
  const homes = (await (await import("node:fs/promises")).readFile(process.env.BUTLER_DATA!, "utf8")).trim().split("\n");
  expect(homes[0]!.split("|")[0]).toBe(join(controlled.dataRoot, "home"));
  expect(homes[1]!.split("|")[0]).toBe(join(warm.dataRoot, "home"));
  expect(homes[2]!.split("|")[0]).toBe(normalHome);
  expect(homes[0]).toContain('"bash":"deny"');
  expect(homes[0]).toContain(join(controlled.dataRoot, "xdg-config"));
  expect(homes[0]).toContain(normalDataRoot);
  expect(homes[0]).toContain(join(controlled.cacheRoot, "xdg-cache"));
  expect(homes[0]).toContain(join(controlled.dataRoot, "opencode-config"));
  expect(homes[0]).toContain("legacy-hidden");
  expect(homes[1]).toContain(join(warm.dataRoot, "home"));
  expect(homes[1]).toContain(join(controlled.cacheRoot, "xdg-cache"));
  expect(homes[2]).toContain(normalHome);
  expect(homes[2]).toContain(normalDataRoot);
  expect(homes[2]).toContain("legacy-visible");
  expect(homes[2]).not.toContain('"bash":"deny"');
  process.env.PATH = previousPath;
  process.env.BUTLER_DATA = previousLog;
  process.env.HOME = previousHome;
  if (previousXdgData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousXdgData;
});

test("controlled command argv uses documented isolation/model flags", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-controlled-argv-"));
  const plan = createBenchmarkPlan({ runId: "controlled-argv", seed: 18, runRoot: join(root, "run"), sourceRoot: join(root, "source"), controlledModel: "openai/gpt-5.5" });
  const arm = plan.arms.find((candidate) => candidate.agent === "hermes" && candidate.track === "controlled" && candidate.cache === "cold")!;
  const hermes = commandFor("hermes", { arm, fixture: AGENT_BENCHMARK_FIXTURES[0]!, prompt: "turn", sessionId: null, sourceEvidenceRoot: "", runtimeInstructions: "", signal: new AbortController().signal });
  expect(hermes.args).toContain("--safe-mode");
  expect(hermes.args).toContain("--toolsets");
  expect(hermes.args).toContain("web,file");
  expect(hermes.args).not.toContain("terminal");
  expect(hermes.args).toContain("--yolo");
  expect(hermes.args).toEqual(expect.arrayContaining(["chat", "-Q", "-q"]));
  expect(hermes.args).not.toContain("-z");
  expect(hermes.args).not.toContain("--usage-file");
  expect(hermes.args).toContain("--provider");
  expect(hermes.args).toContain("openai-codex");
  expect(hermes.args).toContain("--model");
  expect(hermes.args).toContain("gpt-5.5");
  expect(hermes.args).toContain("--reasoning");
  expect(hermes.args).toContain("medium");
  const queryIndex = hermes.args.indexOf("-q");
  expect(hermes.args[queryIndex + 1]).toBe("turn");
  expect(queryIndex).toBe(hermes.args.length - 2);
  const resumedHermes = commandFor("hermes", { arm, fixture: AGENT_BENCHMARK_FIXTURES[0]!, prompt: "turn", sessionId: "session-1", sourceEvidenceRoot: "", runtimeInstructions: "", signal: new AbortController().signal });
  expect(resumedHermes.args).toContain("--resume");
  expect(resumedHermes.args).toContain("session-1");
  const resumedQueryIndex = resumedHermes.args.indexOf("-q");
  expect(resumedHermes.args[resumedQueryIndex + 1]).toBe("turn");
  expect(resumedHermes.args.indexOf("--resume")).toBeLessThan(resumedQueryIndex);
  expect(resumedQueryIndex).toBe(resumedHermes.args.length - 2);
  const landingArm = plan.arms.find((candidate) => candidate.agent === "hermes" && candidate.scenario === "butler_landing_page" && candidate.track === "controlled" && candidate.cache === "cold")!;
  const hermesOneShot = commandFor("hermes", { arm: landingArm, fixture: AGENT_BENCHMARK_FIXTURES[2]!, prompt: "turn", sessionId: null, sourceEvidenceRoot: "", runtimeInstructions: "", signal: new AbortController().signal });
  expect(hermesOneShot.args).toContain("-z");
  expect(hermesOneShot.args[hermesOneShot.args.indexOf("-z") + 1]).toBe("turn");
  expect(hermesOneShot.args).toContain("--usage-file");
  expect(hermesOneShot.args.find((arg) => arg.endsWith("/evidence/hermes-usage.json"))).toBeTruthy();
  const recommendedArm = recommendedArmFrom(arm);
  const recommended = commandFor("hermes", { arm: recommendedArm, fixture: AGENT_BENCHMARK_FIXTURES[0]!, prompt: "turn", sessionId: null, sourceEvidenceRoot: "", runtimeInstructions: "", signal: new AbortController().signal });
  expect(recommended.args).toEqual(expect.arrayContaining(["chat", "-Q", "-q"]));
  expect(recommended.args[recommended.args.indexOf("-q") + 1]).toBe("turn");
  expect(recommended.args.indexOf("-q")).toBe(recommended.args.length - 2);
  expect(recommended.args).not.toContain("-z");
  expect(recommended.args).not.toContain("--usage-file");
  expect(recommended.args).not.toContain("--provider");
  expect(recommended.args).not.toContain("--model");
  expect(recommended.args).not.toContain("--reasoning");
  expect(recommended.args).not.toContain("--safe-mode");
  expect(recommended.args).not.toContain("--toolsets");
  expect(recommended.args).not.toContain("--yolo");
  const recommendedLanding = recommendedArmFrom(landingArm);
  const recommendedOneShot = commandFor("hermes", { arm: recommendedLanding, fixture: AGENT_BENCHMARK_FIXTURES[2]!, prompt: "turn", sessionId: null, sourceEvidenceRoot: "", runtimeInstructions: "", signal: new AbortController().signal });
  expect(recommendedOneShot.args).toContain("-z");
  expect(recommendedOneShot.args).toContain("--usage-file");
  const nonSolArm = createBenchmarkPlan({ runId: "non-sol-command", seed: 18, runRoot: join(root, "non-sol-run"), sourceRoot: join(root, "non-sol-source"), controlledModel: "anthropic/claude-sonnet-4", controlledReasoning: "low" }).arms.find((candidate) => candidate.agent === "hermes" && candidate.track === "controlled" && candidate.scenario === "current_web_research")!;
  const nonSolCommand = commandFor("hermes", { arm: nonSolArm, fixture: AGENT_BENCHMARK_FIXTURES[1]!, prompt: "turn", sessionId: null, sourceEvidenceRoot: "", runtimeInstructions: "", signal: new AbortController().signal });
  expect(nonSolCommand.args).not.toContain("--provider");
  expect(nonSolCommand.args).toContain("--model");
  expect(nonSolCommand.args).toContain("claude-sonnet-4");
  const opencodeArm = plan.arms.find((candidate) => candidate.agent === "opencode" && candidate.track === "controlled" && candidate.cache === "cold")!;
  const opencode = commandFor("opencode", { arm: opencodeArm, fixture: AGENT_BENCHMARK_FIXTURES[0]!, prompt: "turn", sessionId: null, sourceEvidenceRoot: "", runtimeInstructions: "", signal: new AbortController().signal });
  expect(opencode.args).toContain("--auto");
  expect(opencode.args).toContain("openai/gpt-5.5");
});

test("Hermes usage file parser keeps bounded scalar telemetry and fails closed", () => {
  const parsed = parseHermesUsageFile(JSON.stringify({
    session_id: "hermes-session",
    model: "gpt-5.6-sol",
    provider: "openai-codex",
    input_tokens: 10,
    cache_read_tokens: 2,
    cache_write_tokens: 1,
    output_tokens: 8,
    total_tokens: 21,
    api_calls: 1,
    completed: true,
    failed: false,
    failure: null,
    prompt: "do not persist",
    tool_payload: { secret: "never" },
  }));
  expect(parsed).toMatchObject({ sessionId: "hermes-session", model: "gpt-5.6-sol", provider: "openai-codex", inputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 1, outputTokens: 8, totalTokens: 21, apiCalls: 1, completed: true, failed: false });
  const invalid = parseHermesUsageFile(JSON.stringify({ session_id: "/Users/private/session", model: "gpt-5.6-sol|secret", input_tokens: -1, output_tokens: 1e20, api_calls: "1", failure: "token=secret /Users/private" }));
  expect(invalid.sessionId).toBeNull();
  expect(invalid.model).toBeNull();
  expect(invalid.inputTokens).toBeNull();
  expect(invalid.outputTokens).toBeNull();
  expect(invalid.apiCalls).toBeNull();
  expect(invalid.failure).toBeNull();
  expect(parseHermesUsageFile("not-json").totalTokens).toBeNull();
  expect(parseHermesUsageFile("x".repeat(64 * 1024 + 1)).totalTokens).toBeNull();
  expect(parseHermesUsageFile("é".repeat(33_000)).totalTokens).toBeNull();
  expect(hermesUsageDiagnosticFor(parseHermesUsageFile(JSON.stringify({ completed: false, failed: false })))).toBe("Hermes usage telemetry reported an incomplete or failed one-shot.");
  expect(hermesUsageDiagnosticFor(parseHermesUsageFile(JSON.stringify({ completed: true, failed: true })))).toBe("Hermes usage telemetry reported an incomplete or failed one-shot.");
  expect(hermesUsageDiagnosticFor(parseHermesUsageFile(JSON.stringify({ completed: true, failed: false, failure: "safe failure" })))).toBe("Hermes usage telemetry reported an incomplete or failed one-shot.");
});

test("Hermes direct continuation uses stderr session identity and aggregate telemetry", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-hermes-session-gate-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "hermes");
  writeFileSync(script, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo hermes; elif [ \"$1\" = \"auth\" ]; then echo 'nous configured'; elif [ \"$1\" = \"config\" ]; then echo '{\"model\":{\"default\":\"gpt-5.6-sol\",\"provider\":\"openai-codex\"}}'; else echo 'session_id: stdout-only-session'; echo answer; fi\n", "utf8");
  chmodSync(script, 0o755);
  const previousPath = process.env.PATH;
  const previousHome = process.env.HOME;
  process.env.PATH = bin;
  process.env.HOME = root;
  mkdirSync(join(root, ".hermes"), { recursive: true });
  writeFileSync(join(root, ".hermes", "auth.json"), "{}", "utf8");
  try {
    const plan = createBenchmarkPlan({ runId: "hermes-session-gate", seed: 41, runRoot: join(root, "run"), sourceRoot: join(root, "source"), controlledModel: "openai/gpt-5.5" });
    const arm = plan.arms.find((candidate) => candidate.agent === "hermes" && candidate.scenario === "direct_conversation" && candidate.track === "controlled" && candidate.cache === "cold")!;
    mkdirSync(arm.outputRoot, { recursive: true });
    const adapter = new ExternalCliAdapter("hermes", { execute: executeCommand });
    expect((await adapter.preflight()).gateCode).toBe("none");
    const result = await adapter.run({ arm, fixture: AGENT_BENCHMARK_FIXTURES[0]!, prompt: "turn", sessionId: null, sourceEvidenceRoot: "", runtimeInstructions: "runtime", signal: new AbortController().signal });
    expect(result.gateCode).toBe("measurement_unavailable");
  } finally {
    process.env.PATH = previousPath;
    process.env.HOME = previousHome;
  }
});

test("Hermes one-shot failures remain failed while successful missing usage is gated", async () => {
  const modes = ["exit-failure", "usage-failure", "missing-usage"] as const;
  for (const mode of modes) {
    const root = mkdtempSync(join(tmpdir(), `agent-benchmark-hermes-${mode}-`));
    const executable = join(root, "hermes");
    writeFileSync(executable, "", "utf8");
    chmodSync(executable, 0o755);
    mkdirSync(join(root, ".hermes"), { recursive: true });
    writeFileSync(join(root, ".hermes", "auth.json"), "{}", "utf8");
    const previousPath = process.env.PATH;
    const previousHome = process.env.HOME;
    process.env.PATH = root;
    process.env.HOME = root;
    const resultFor = (exitCode: number | null, stdout = "", stderr = "") => ({
      exitCode,
      stdout,
      stderr,
      startedAtMs: 10,
      endedAtMs: 20,
      firstOutputAtMs: stdout ? 12 : null,
      timedOut: false,
      cancelled: false,
    });
    const executor: CommandExecutor = {
      execute: async ({ args }) => {
        if (args[0] === "--version") return resultFor(0, "hermes 0.20.0\n");
        if (args[0] === "auth") return resultFor(0, "nous configured\n");
        if (args[0] === "config") {
          return args[2] === "agent.reasoning_effort"
            ? resultFor(0, '"medium"\n')
            : resultFor(0, '{"default":"gpt-5.5","provider":"openai-codex"}\n');
        }
        const usageIndex = args.indexOf("--usage-file");
        const usagePath = usageIndex >= 0 ? args[usageIndex + 1] : null;
        if (usagePath && mode !== "missing-usage") {
          writeFileSync(usagePath, JSON.stringify({
            model: "gpt-5.5",
            provider: "openai-codex",
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
            api_calls: 1,
            completed: mode !== "usage-failure",
            failed: mode === "usage-failure",
            failure: mode === "usage-failure" ? "safe failure" : null,
          }), "utf8");
        }
        return resultFor(mode === "exit-failure" ? 7 : 0, "answer\n", mode === "exit-failure" ? "product failed\n" : "");
      },
    };
    try {
      const plan = createBenchmarkPlan({ runId: `hermes-${mode}`, seed: 41, runRoot: join(root, "run"), sourceRoot: join(root, "source"), controlledModel: "openai/gpt-5.5" });
      const arm = plan.arms.find((candidate) => candidate.agent === "hermes" && candidate.scenario === "current_web_research" && candidate.track === "controlled" && candidate.cache === "cold")!;
      mkdirSync(arm.outputRoot, { recursive: true });
      const adapter = new ExternalCliAdapter("hermes", executor);
      expect((await adapter.preflight()).gateCode).toBe("none");
      const adapterResult = await adapter.run({ arm, fixture: AGENT_BENCHMARK_FIXTURES[1]!, prompt: "turn", sessionId: null, sourceEvidenceRoot: "", runtimeInstructions: "runtime", signal: new AbortController().signal });
      const observation = evaluateAdapterResult(arm, AGENT_BENCHMARK_FIXTURES[1]!, adapterResult);
      if (mode === "missing-usage") {
        expect(adapterResult.gateCode).toBe("measurement_unavailable");
        expect(adapterResult.exitCode).toBe(0);
        expect(observation.terminalState).toBe("gated");
      } else {
        expect(adapterResult.gateCode).toBe("none");
        expect(adapterResult.exitCode).not.toBe(0);
        expect(observation.terminalState).toBe("failed");
      }
    } finally {
      process.env.PATH = previousPath;
      process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("external adapter gates successful runs when command output completeness is unknown", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-incomplete-output-"));
  const executable = join(root, "hermes");
  writeFileSync(executable, "", "utf8");
  chmodSync(executable, 0o755);
  mkdirSync(join(root, ".hermes"), { recursive: true });
  writeFileSync(join(root, ".hermes", "auth.json"), "{}", "utf8");
  const previousPath = process.env.PATH;
  const previousHome = process.env.HOME;
  process.env.PATH = root;
  process.env.HOME = root;
  const resultFor = (outputComplete?: boolean) => ({
    exitCode: 0,
    stdout: "answer\n",
    stderr: "",
    startedAtMs: 10,
    endedAtMs: 20,
    firstOutputAtMs: 12,
    ...(outputComplete === undefined ? {} : { outputComplete }),
    timedOut: false,
    cancelled: false,
  });
  const executor: CommandExecutor = {
    execute: async ({ args }) => {
      if (args[0] === "--version") return resultFor(true);
      if (args[0] === "auth") return { ...resultFor(true), stdout: "nous configured\n" };
      if (args[0] === "config") return { ...resultFor(true), stdout: args[2] === "agent.reasoning_effort" ? '"medium"\n' : '{"default":"gpt-5.5","provider":"openai-codex"}\n' };
      return resultFor(false);
    },
  };
  try {
    const plan = createBenchmarkPlan({ runId: "incomplete-output", seed: 44, runRoot: join(root, "run"), sourceRoot: join(root, "source"), controlledModel: "openai/gpt-5.5" });
    const arm = plan.arms.find((candidate) => candidate.agent === "hermes" && candidate.scenario === "current_web_research" && candidate.cache === "cold")!;
    mkdirSync(arm.outputRoot, { recursive: true });
    const adapter = new ExternalCliAdapter("hermes", executor);
    expect((await adapter.preflight()).gateCode).toBe("none");
    const result = await adapter.run({ arm, fixture: AGENT_BENCHMARK_FIXTURES[1]!, prompt: "turn", sessionId: null, sourceEvidenceRoot: "", runtimeInstructions: "runtime", signal: new AbortController().signal });
    expect(result.exitCode).toBe(0);
    expect(result.gateCode).toBe("measurement_unavailable");
    expect(result.stderr).toContain("output stream completeness");
  } finally {
    process.env.PATH = previousPath;
    process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("timeout escalates an uncooperative process after bounded grace", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-timeout-"));
  const result = await executeCommand({
    executable: process.execPath,
    args: ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
    cwd: root,
    env: safeEnvironment(),
    timeoutMs: 40,
    signal: new AbortController().signal,
  });
  expect(result.timedOut).toBe(true);
  expect(result.exitCode).not.toBe(0);
});

test("command executor records first stdout emission before terminal", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-streaming-"));
  const result = await executeCommand({
    executable: process.execPath,
    args: ["-e", "setTimeout(()=>process.stdout.write('useful'),20); setTimeout(()=>process.exit(0),40)"],
    cwd: root,
    env: safeEnvironment(),
    timeoutMs: 500,
    signal: new AbortController().signal,
  });
  expect(result.firstOutputAtMs).not.toBeNull();
  expect(result.firstOutputAtMs!).toBeGreaterThanOrEqual(result.startedAtMs);
  expect(result.firstOutputAtMs!).toBeLessThanOrEqual(result.endedAtMs);
  expect(result.outputComplete).toBe(true);
});

test("command executor closes non-interactive stdin so EOF-driven products can finish", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-stdin-eof-"));
  const result = await executeCommand({
    executable: process.execPath,
    args: ["-e", "process.stdin.resume();process.stdin.once('end',()=>{process.stdout.write('eof');process.exit(0)});"],
    cwd: root,
    env: safeEnvironment(),
    timeoutMs: 500,
    signal: new AbortController().signal,
  });
  expect(result.exitCode).toBe(0);
  expect(result.timedOut).toBe(false);
  expect(result.stdout).toBe("eof");
  expect(result.firstOutputAtMs).not.toBeNull();
  expect(result.firstOutputAtMs!).toBeLessThanOrEqual(result.endedAtMs);
  expect(result.outputComplete).toBe(true);
});

test("command executor settles rapid EOF exits without losing close events", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-stdin-race-"));
  const results = await Promise.all(Array.from({ length: 32 }, () => executeCommand({
    executable: process.execPath,
    args: ["-e", "process.stdin.resume();process.stdin.once('end',()=>process.stdout.write('eof'));"],
    cwd: root,
    env: safeEnvironment(),
    timeoutMs: 2_000,
    signal: new AbortController().signal,
  })));
  expect(results.every((result) => result.exitCode === 0 && !result.timedOut && result.stdout === "eof")).toBe(true);
  expect(results.every((result) => result.firstOutputAtMs !== null && result.firstOutputAtMs! <= result.endedAtMs)).toBe(true);
  expect(results.every((result) => result.outputComplete === true)).toBe(true);
});

test("command executor exit fallback requires both output streams to close", () => {
  expect(canSettleAfterExit(false, true, true)).toBe(false);
  expect(canSettleAfterExit(true, false, true)).toBe(false);
  expect(canSettleAfterExit(true, true, false)).toBe(false);
  expect(canSettleAfterExit(true, true, true)).toBe(true);
});

test("command executor treats destroyed zero-length streams as drained after exit", () => {
  expect(outputStreamIsComplete({ destroyed: true, readableLength: 0 })).toBe(true);
  expect(outputStreamIsComplete({ closed: true, readableLength: 0 })).toBe(true);
  expect(outputStreamIsComplete({ readableEnded: true, readableLength: 0 })).toBe(true);
  expect(outputStreamIsComplete({ destroyed: true, readableLength: 1 })).toBe(false);
  expect(outputStreamIsComplete({ readableLength: 0 })).toBe(false);
});

test("landing evaluation rejects source mutation, missing validation, and weak generated claims", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-landing-eval-"));
  const plan = createBenchmarkPlan({ runId: "landing-eval", seed: 8, runRoot: join(root, "run"), sourceRoot: join(root, "source"), controlledModel: "openai/gpt-5.5" });
  const arm = plan.arms.find((candidate) => candidate.scenario === "butler_landing_page" && candidate.track === "controlled" && candidate.cache === "cold" && candidate.agent === "butler")!;
  mkdirSync(arm.outputRoot, { recursive: true });
  for (const path of ["index.html", "styles.css", "README.md", "package.json"]) {
    writeFileSync(join(arm.outputRoot, path), "Butler is a local-first assistant with an agent runtime and desktop app. Durable project tracking stores state; evidence README.md package.json.", "utf8");
  }
  const result = baseAdapterResult({
    finalText: null,
    operations: { build: { ran: true, passed: true, command: "npm run build" }, tests: { ran: true, passed: true, command: "npm run test" } },
    changedPaths: ["index.html", "styles.css", "README.md"],
    landingValidation: { buildPassed: true, testPassed: true, browserAvailable: true, desktop: { loaded: true, overflowFree: true, screenshotRef: "desktop.png" }, mobile: { loaded: true, overflowFree: true, screenshotRef: "mobile.png" }, visualQuality: null, diagnostics: [] },
  });
  expect(evaluateAdapterResult(arm, AGENT_BENCHMARK_FIXTURES.find((fixture) => fixture.id === "butler_landing_page")!, result).terminalState).toBe("accepted");
  const evidenceSource = join(root, "evidence-source");
  mkdirSync(evidenceSource, { recursive: true });
  writeFileSync(join(evidenceSource, "README.md"), "Butler is a local-first AI agent runtime for project work. Butler provides durable workstreams and a local desktop app.", "utf8");
  writeFileSync(join(evidenceSource, "package.json"), "{}", "utf8");
  const evidenceSnapshot = materializeRepositoryEvidence(evidenceSource, join(root, "evidence-snapshot"));
  expect(evaluateAdapterResult(arm, AGENT_BENCHMARK_FIXTURES.find((fixture) => fixture.id === "butler_landing_page")!, result, { repositoryEvidenceRoot: evidenceSnapshot.root }).terminalState).toBe("accepted");
  writeFileSync(join(arm.outputRoot, "README.md"), "Butler is a local-first assistant with an agent runtime and desktop app. Durable project tracking stores state.", "utf8");
  expect(evaluateAdapterResult(arm, AGENT_BENCHMARK_FIXTURES.find((fixture) => fixture.id === "butler_landing_page")!, result, { repositoryEvidenceRoot: evidenceSnapshot.root }).terminalState).toBe("rejected");
  expect(evaluateAdapterResult(arm, AGENT_BENCHMARK_FIXTURES.find((fixture) => fixture.id === "butler_landing_page")!, result, { sourceMutation: true }).terminalState).toBe("rejected");
  const weak = baseAdapterResult({ ...result, landingValidation: undefined });
  expect(evaluateAdapterResult(arm, AGENT_BENCHMARK_FIXTURES.find((fixture) => fixture.id === "butler_landing_page")!, weak).terminalState).toBe("rejected");
});

test("checkpoint persistence redacts absolute roots and raw answers", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-privacy-"));
  const plan = createBenchmarkPlan({ runId: "privacy", seed: 10, runRoot: join(root, "run"), sourceRoot: "/Users/private-butler-source", controlledModel: "openai/gpt-5.5" });
  const arm = plan.arms[0]!;
  const observation = evaluateAdapterResult(arm, AGENT_BENCHMARK_FIXTURES.find((fixture) => fixture.id === arm.scenario)!, baseAdapterResult({ finalText: "api_key=secret /Users/private-butler-source hidden reasoning" }));
  const result = {
    schema: "butler.agent-benchmark.v1" as const,
    kind: "agent_benchmark_result" as const,
    run: { runId: plan.runId, seed: plan.seed, baselineSha: plan.baselineSha, runRoot: plan.runRoot, state: "reported" as const },
    plan,
    observations: [observation],
  };
  const path = join(root, "result.json");
  await createFileCheckpointStore(path).save(result);
  const persisted = await (await import("node:fs/promises")).readFile(path, "utf8");
  expect(persisted).not.toContain("finalText");
  expect(persisted).not.toContain("/Users/private-butler-source");
  expect(persisted).not.toContain("secret");
  expect(persisted).not.toContain("$1");
  expect(JSON.parse(persisted).observations[0].answerHash).toMatch(/^[a-f0-9]{64}$/u);
  expect(redactBenchmarkResult(result).plan.sourceRoot).toBe("<source-root>");
});

test("checkpoint persistence redacts free-text diagnostics and tool names", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-privacy-fields-"));
  const plan = createBenchmarkPlan({ runId: "privacy-fields", seed: 17, runRoot: join(root, "run"), sourceRoot: join(root, "source"), controlledModel: "openai/gpt-5.5" });
  const arm = plan.arms[0]!;
  const observation = {
    ...evaluateAdapterResult(arm, AGENT_BENCHMARK_FIXTURES.find((fixture) => fixture.id === arm.scenario)!, baseAdapterResult({ finalText: "ok" })),
    diagnostics: ["api_key=secret /Users/private/path $1"],
    evidenceRefs: ["/Users/private/screenshot.png"],
    tools: { calls: 1, failedCalls: 0, records: [{ callId: "/Users/private/call token=secret", name: "/Users/private/tool token=secret", status: "completed" as const, startedAtMs: null, endedAtMs: null }] },
    operations: { userInterventions: 0, retries: null, changedFiles: 0, tests: { ran: true, passed: false, command: "/Users/private/test token=secret $1" }, build: { ran: true, passed: false, command: "/Users/private/build token=secret $1" } },
    evaluation: { ...evaluateAdapterResult(arm, AGENT_BENCHMARK_FIXTURES.find((fixture) => fixture.id === arm.scenario)!, baseAdapterResult({ finalText: "ok" })).evaluation, evaluatorNotes: ["password=secret /Users/private/path $1"], evidenceRefs: ["/Users/private/evidence"] },
  };
  const result = { schema: "butler.agent-benchmark.v1" as const, kind: "agent_benchmark_result" as const, run: { runId: plan.runId, seed: plan.seed, baselineSha: plan.baselineSha, runRoot: plan.runRoot, state: "reported" as const }, plan, observations: [observation] };
  const path = join(root, "result.json");
  await createFileCheckpointStore(path).save(result);
  const persisted = await (await import("node:fs/promises")).readFile(path, "utf8");
  expect(persisted).not.toContain("secret");
  expect(persisted).not.toContain("/Users/private");
  expect(persisted).not.toContain("$1");
});

function baseAdapterResult(overrides: Partial<AdapterRunResult> = {}): AdapterRunResult {
  return {
    exitCode: 0,
    gateCode: "none",
    timedOut: false,
    cancelled: false,
    stdout: "",
    stderr: "",
    adapterVersion: "fixture",
    provider: "fixture",
    finalText: "fixture",
    sessionId: "fixture-session",
    effectiveConfig: { model: "openai/gpt-5.5" },
    usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20, modelRequests: 1 },
    tools: { calls: 0, failedCalls: 0, records: [] },
    timing: { submittedAtMs: 1, firstUsefulOutputAtMs: 2, terminalAtMs: 3, totalElapsedMs: 2 },
    operations: { userInterventions: 0, retries: 0, changedFiles: 0, tests: { ran: null, passed: null, command: null }, build: { ran: null, passed: null, command: null } },
    changedPaths: [],
    evidenceRefs: [],
    ...overrides,
  };
}

function validLanding() {
  return {
    buildPassed: true,
    testPassed: true,
    browserAvailable: true,
    desktop: { loaded: true, overflowFree: true, screenshotRef: "desktop.png" },
    mobile: { loaded: true, overflowFree: true, screenshotRef: "mobile.png" },
    visualQuality: null,
    diagnostics: [],
  } as const;
}

function fakeAdapter(calls: string[], agent: AgentAdapter["agent"]): AgentAdapter {
  return {
    agent,
    async preflight(): Promise<PreflightResult> {
      return {
        available: true,
        executable: "fixture-adapter",
        version: "fixture-1",
        authenticated: true,
        configVerified: true,
        gateCode: "none",
        diagnostic: null,
      };
    },
    async run(input: AdapterRunInput): Promise<AdapterRunResult> {
      calls.push(input.arm.key);
      if (input.arm.scenario === "butler_landing_page") {
        for (const path of ["index.html", "styles.css", "README.md", "package.json"]) {
          writeFileSync(join(input.arm.outputRoot, path), "Butler local-first assistant", "utf8");
        }
      }
      return {
        exitCode: 0,
        gateCode: "none",
        timedOut: false,
        cancelled: false,
        stdout: "",
        stderr: "",
        adapterVersion: "fixture-1",
        provider: "fixture",
        finalText: "Reproducibility requires pinned inputs and recorded environment. Unavailable measurements remain unknown rather than fabricated. The correction is reflected in the final synthesis.",
        sessionId: "fixture-session",
        usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200, modelRequests: 1 },
        tools: { calls: 0, failedCalls: 0, records: [] },
        timing: { submittedAtMs: 1, firstUsefulOutputAtMs: 2, terminalAtMs: 3, totalElapsedMs: 2 },
        operations: {
          userInterventions: 0,
          retries: 0,
          changedFiles: input.arm.scenario === "butler_landing_page" ? 3 : 0,
          tests: { ran: input.arm.scenario === "butler_landing_page", passed: input.arm.scenario === "butler_landing_page", command: "bun test" },
          build: { ran: input.arm.scenario === "butler_landing_page", passed: input.arm.scenario === "butler_landing_page", command: "bun run check" },
        },
        changedPaths: input.arm.scenario === "butler_landing_page" ? ["index.html", "styles.css", "README.md"] : [],
        evidenceRefs: [],
      };
    },
  };
}

function emptyObservation(arm: ReturnType<typeof createBenchmarkPlan>["arms"][number]) {
  return {
    schema: "butler.agent-benchmark.v1" as const,
    kind: "agent_benchmark_observation" as const,
    arm,
    terminalState: "failed" as const,
    gateCode: "none" as const,
    adapterVersion: null,
    effectiveConfig: arm.effectiveConfig,
    usage: { inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, totalTokens: null, modelRequests: null },
    tools: { calls: null, failedCalls: null, records: [] },
    timing: { submittedAtMs: null, firstUsefulOutputAtMs: null, terminalAtMs: null, totalElapsedMs: null },
    operations: { userInterventions: null, retries: null, changedFiles: null, tests: { ran: null, passed: null, command: null }, build: { ran: null, passed: null, command: null } },
    evaluation: { accepted: null, factualAccuracy: null, sourceQuality: null, visualQuality: null, resultQuality: null, evaluatorNotes: [], evidenceRefs: [] },
    visualReview: null,
    privacy: { redacted: true, promptLeak: false, credentialLeak: false, rawToolPayloadLeak: false, privatePathLeak: false, hiddenReasoningLeak: false },
    acceptedResultPerToken: null,
    promptHash: null,
    answerHash: null,
    changedPaths: [],
    diagnostics: [],
    evidenceRefs: [],
  };
}
