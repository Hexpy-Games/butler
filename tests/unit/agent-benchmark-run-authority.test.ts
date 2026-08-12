import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBenchmarkPlan,
  createFileCheckpointStore,
  runAgentBenchmark,
  runAgentBenchmarkCli,
} from "../support/agent-benchmark/index.ts";
import {
  createGatedBenchmarkObservation,
  resumeOrInitialize,
} from "../support/agent-benchmark/checkpoint.ts";
import { validateBenchmarkPlan } from "../support/agent-benchmark/isolation.ts";
import type {
  AdapterRunInput,
  AdapterRunResult,
  AgentAdapter,
  BenchmarkResultFile,
  PreflightResult,
} from "../support/agent-benchmark/contracts.ts";

const CURRENT_MAIN_SHA = "65494154f6e9ddbfb20458bc67250c7d15b5d13d";
const CURRENT_ATTRIBUTION_SHA = "269a0fc72c7f2c77b8df9ccb37e86761ab478435";

test("M1 preflight accepts its exact plan source and gates a checkout mismatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-m1-source-"));
  const sourceRoot = join(root, "source");
  execFileSync("git", ["clone", "--quiet", "--local", process.cwd(), sourceRoot]);
  const sourceRevision = execFileSync(
    "git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" },
  ).trim();

  for (const revision of [CURRENT_MAIN_SHA, CURRENT_ATTRIBUTION_SHA]) {
    const plan = m1Plan(root, sourceRoot, `known-${revision.slice(0, 8)}`, revision);
    expect(() => validateBenchmarkPlan(plan)).not.toThrow();
  }

  const adapters = fakeAdapters();
  const exact = m1Plan(root, sourceRoot, "exact", sourceRevision);
  const exactRun = await runAgentBenchmark({
    plan: exact,
    adapters,
    store: createFileCheckpointStore(join(exact.runRoot, "result.json")),
    signal: new AbortController().signal,
    landingValidator: async () => validLanding(),
    mode: "preflight-only",
  });
  expect(exactRun.result.observations).toHaveLength(12);
  expect(exactRun.result.observations.every((item) =>
    !item.diagnostics.some((value) => value.includes("Pinned source checkout")))).toBe(true);

  const mismatch = m1Plan(root, sourceRoot, "mismatch", "a".repeat(40));
  const mismatchRun = await runAgentBenchmark({
    plan: mismatch,
    adapters,
    store: createFileCheckpointStore(join(mismatch.runRoot, "result.json")),
    signal: new AbortController().signal,
    landingValidator: async () => validLanding(),
    mode: "preflight-only",
  });
  expect(mismatchRun.result.observations).toHaveLength(12);
  expect(mismatchRun.result.observations.every((item) =>
    item.gateCode === "configuration_unverifiable" &&
      item.diagnostics.some((value) => value.includes("Pinned source checkout")))).toBe(true);

  const armMismatch = {
    ...exact,
    arms: exact.arms.map((arm, index) => index === 0
      ? { ...arm, sourceRevision: "b".repeat(40) }
      : arm),
  };
  expect(() => validateBenchmarkPlan(armMismatch)).toThrow("source revision mismatch");
});

test("CLI preserves one manifest identity, rejects replacement, and resumes identically", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-manifest-"));
  const sourceRoot = join(root, "source");
  execFileSync("git", ["clone", "--quiet", "--local", process.cwd(), sourceRoot]);
  const sourceRevision = execFileSync(
    "git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" },
  ).trim();
  const runRoot = join(root, "run");
  const args = cliArgs(runRoot, sourceRoot, sourceRevision, 1);

  const manifestPath = join(runRoot, "manifest.json");
  const resultPath = join(runRoot, "result.json");
  const planArgs = [...args];
  planArgs[0] = "plan";
  await runAgentBenchmarkCli(planArgs);
  const manifestBefore = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestBefore) as { createdAt: string };

  const first = JSON.parse(await runAgentBenchmarkCli(args)) as { baselineSha: string };
  expect(first.baselineSha).toBe(sourceRevision);
  const resultBefore = JSON.parse(readFileSync(resultPath, "utf8")) as BenchmarkResultFile;
  expect(resultBefore.plan.createdAt).toBe(manifest.createdAt);

  const resumed = JSON.parse(await runAgentBenchmarkCli(args)) as { baselineSha: string };
  expect(resumed.baselineSha).toBe(sourceRevision);
  expect(readFileSync(manifestPath, "utf8")).toBe(manifestBefore);
  expect((JSON.parse(readFileSync(resultPath, "utf8")) as BenchmarkResultFile)
    .run.planIdentity).toBe(resultBefore.run.planIdentity);

  await expect(runAgentBenchmarkCli(cliArgs(
    runRoot, sourceRoot, sourceRevision, 2,
  ))).rejects.toThrow("manifest identity mismatch");
  await expect(runAgentBenchmarkCli(cliArgs(
    runRoot, sourceRoot, "f".repeat(40), 1,
  ))).rejects.toThrow("manifest identity mismatch");

  const tampered = JSON.parse(manifestBefore) as { fixtures: Array<{ sha256: string }> };
  tampered.fixtures[0]!.sha256 = "0".repeat(64);
  writeFileSync(manifestPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
  await expect(runAgentBenchmarkCli(args)).rejects.toThrow("manifest identity mismatch");
});

test("checkpoint persistence rejects a different plan instead of replacing evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-benchmark-result-identity-"));
  const sourceRoot = process.cwd();
  const firstPlan = m1Plan(root, sourceRoot, "result", "a".repeat(40), 1);
  const secondPlan = m1Plan(root, sourceRoot, "result", "a".repeat(40), 2);
  const first = resumeOrInitialize(firstPlan, null);
  expect(() => resumeOrInitialize(secondPlan, first)).toThrow("checkpoint identity mismatch");

  const store = createFileCheckpointStore(join(root, "result.json"));
  first.observations.push(createGatedBenchmarkObservation(firstPlan.arms[0]!, {
    available: false, executable: null, version: null, authenticated: null,
    configVerified: false, gateCode: "measurement_unavailable", diagnostic: "stable gate",
  }));
  await store.save(first);
  await expect(store.save(resumeOrInitialize(secondPlan, null)))
    .rejects.toThrow("checkpoint identity mismatch");
  await expect(store.save({
    ...first,
    observations: [{ ...first.observations[0]!, diagnostics: ["replacement gate"] }],
  })).rejects.toThrow("terminal evidence mismatch");
});

function m1Plan(
  root: string,
  sourceRoot: string,
  runId: string,
  baselineSha: string,
  seed = 1,
) {
  return createBenchmarkPlan({
    campaign: "m1-v2",
    runId,
    seed,
    runRoot: join(root, `run-${runId}`),
    sourceRoot,
    baselineSha,
    controlledModel: "openai/gpt-5.6-sol",
    controlledReasoning: "medium",
  });
}

function cliArgs(
  runRoot: string,
  sourceRoot: string,
  sourceRevision: string,
  seed: number,
): string[] {
  return [
    "pilot", "--campaign", "m1-v2", "--seed", String(seed),
    "--run-id", "manifest-resume", "--run-root", runRoot,
    "--source-root", sourceRoot, "--output", join(runRoot, "report"),
    "--controlled-model", "openai/gpt-5.6-sol",
    "--controlled-reasoning", "medium", "--source-revision", sourceRevision,
    "--repetitions", "3",
  ];
}

function fakeAdapters(): Readonly<Record<"butler" | "hermes" | "opencode", AgentAdapter>> {
  return {
    butler: fakeAdapter("butler"),
    hermes: fakeAdapter("hermes"),
    opencode: fakeAdapter("opencode"),
  };
}

function fakeAdapter(agent: AgentAdapter["agent"]): AgentAdapter {
  return {
    agent,
    async preflight(): Promise<PreflightResult> {
      return {
        available: true, executable: "fixture", version: "fixture",
        authenticated: true, configVerified: true, gateCode: "none", diagnostic: null,
      };
    },
    async run(_input: AdapterRunInput): Promise<AdapterRunResult> {
      throw new Error("preflight-only test must not execute an adapter");
    },
  };
}

function validLanding() {
  return {
    buildPassed: true, testPassed: true, browserAvailable: true, visualQuality: null,
    desktop: { loaded: true, overflowFree: true, screenshotRef: "desktop.png" },
    mobile: { loaded: true, overflowFree: true, screenshotRef: "mobile.png" },
    diagnostics: [],
  } as const;
}
