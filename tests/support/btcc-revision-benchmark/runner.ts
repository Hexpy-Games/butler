import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runBtccR3ElectronHarness,
  type ElectronHarnessOptions,
  type ElectronScenario,
} from "../../e2e/btcc-r3-electron-harness.ts";
import type {
  BenchmarkEvidenceFile,
  BtccRevision,
  MaterializedBenchmarkPrompt,
} from "./contracts.ts";
import { BTCC_REVISION_BENCHMARK_SCHEMA } from "./contracts.ts";
import { collectRawProductObservation } from "./product-observation.ts";

export interface BenchmarkRunnerFixture {
  path: string;
  text: string;
}

export interface BenchmarkRunnerConfig {
  runRoot: string;
  sourceData?: string;
  fixtures: BenchmarkRunnerFixture[];
  artifactPathsByPrompt: Record<string, string[]>;
}

export interface BenchmarkRunnerDependencies {
  collectObservation?: typeof collectRawProductObservation;
  persist?: (evidence: BenchmarkEvidenceFile) => Promise<void> | void;
  verifyTargets?: (
    targets: BenchmarkEvidenceFile["plan"]["targets"],
  ) => Promise<void> | void;
  runHarness?: (
    scenario: ElectronScenario,
    options: ElectronHarnessOptions,
  ) => Promise<Record<string, unknown>>;
}

export async function runBenchmarkPairs(input: {
  config: BenchmarkRunnerConfig;
  evidence: BenchmarkEvidenceFile;
  dependencies?: BenchmarkRunnerDependencies;
}): Promise<BenchmarkEvidenceFile> {
  validateRunInput(input.evidence, input.config);
  const runHarness = input.dependencies?.runHarness ?? runBtccR3ElectronHarness;
  const collectObservation =
    input.dependencies?.collectObservation ?? collectRawProductObservation;
  const persist = input.dependencies?.persist ?? (() => undefined);
  const verifyTargets = input.dependencies?.verifyTargets ?? verifyTargetCheckouts;
  await verifyTargets(input.evidence.plan.targets);
  const completed = new Set(input.evidence.observations.map((observation) =>
    observationKey(observation.promptId, observation.revision),
  ));
  for (const prompt of input.evidence.plan.prompts) {
    for (const revision of prompt.order) {
      const key = observationKey(prompt.id, revision);
      if (completed.has(key)) continue;
      const runRoot = caseRunRoot(input.config.runRoot, prompt.id, revision);
      const scenario = benchmarkScenario(
        input.evidence.plan.runId,
        prompt,
        revision,
        input.config,
      );
      let productEvidence: Record<string, unknown>;
      let timedOut = false;
      try {
        productEvidence = await runHarness(scenario, {
          accessMode: accessMode(input.evidence.plan.targets[revision].permissionMode),
          keepLogs: true,
          model: input.evidence.plan.targets[revision].model,
          reasoningEffort: reasoningEffort(
            input.evidence.plan.targets[revision].reasoningEffort,
          ),
          repoRoot: input.evidence.plan.targets[revision].worktreePath,
          runRoot,
          ...(input.config.sourceData ? { sourceData: input.config.sourceData } : {}),
        });
      } catch (error) {
        if (!isProductTimeout(error)) {
          throw new Error(
            `Benchmark harness incident for ${key}: ${errorMessage(error)}`,
            { cause: error },
          );
        }
        timedOut = true;
        productEvidence = readHarnessEvidence(runRoot);
      }
      const observation = collectObservation({
        artifactPaths: artifactPaths(input.config, prompt.id),
        evidence: productEvidence,
        fixtures: input.config.fixtures,
        prompt,
        revision,
        runId: input.evidence.plan.runId,
        runRoot,
        target: input.evidence.plan.targets[revision],
        timedOut,
      });
      input.evidence.observations.push(observation);
      completed.add(key);
      await persist(input.evidence);
    }
  }
  return input.evidence;
}

function benchmarkScenario(
  runId: string,
  prompt: MaterializedBenchmarkPrompt,
  revision: BtccRevision,
  config: BenchmarkRunnerConfig,
): ElectronScenario {
  const artifacts = artifactPaths(config, prompt.id);
  const expectsWork = prompt.expectedLedgerRoute !== "none";
  return {
    schema: "butler.btcc-r3-electron-scenario.v1",
    id: `${runId}-${prompt.id}-${revision}`,
    session: {
      id: `${prompt.id}-${revision}`,
      kind: prompt.tier === "project_ledger" ? "project" : "chat",
      ...(prompt.tier === "project_ledger"
        ? { projectDisplayName: `BTCC benchmark ${prompt.id} ${revision}` }
        : {}),
      title: `BTCC ${prompt.id} ${revision}`,
    },
    fixtures: config.fixtures,
    steps: [{
      id: prompt.id,
      prompt: prompt.prompt,
      timeoutMs: prompt.timeoutMs,
      reloadAfter: true,
      expect: {
        terminalState: "delivered",
        files: artifacts.map((path) => ({ path })),
        work: expectsWork
          ? {
            exists: true,
            status: "completed",
            planReviewVerdict: "accept",
            resultReviewVerdict: "accept",
          }
          : { exists: false },
      },
    }],
  };
}

function validateRunInput(
  evidence: BenchmarkEvidenceFile,
  config: BenchmarkRunnerConfig,
): void {
  if (
    evidence.schema !== BTCC_REVISION_BENCHMARK_SCHEMA ||
    evidence.kind !== "paired_e2e_evidence"
  ) throw new Error("Benchmark evidence contract does not match");
  if (!config.runRoot.trim()) throw new Error("Benchmark run root is required");
  const seen = new Set<string>();
  for (const observation of evidence.observations) {
    const key = observationKey(observation.promptId, observation.revision);
    if (seen.has(key)) throw new Error(`Duplicate benchmark observation: ${key}`);
    seen.add(key);
  }
  for (const prompt of evidence.plan.prompts) {
    if (
      prompt.expectedLedgerRoute !== "none" &&
      artifactPaths(config, prompt.id).length === 0
    ) {
      throw new Error(`Benchmark artifact paths are missing: ${basePromptId(prompt.id)}`);
    }
  }
}

function artifactPaths(config: BenchmarkRunnerConfig, promptId: string): string[] {
  return config.artifactPathsByPrompt[basePromptId(promptId)] ?? [];
}

function basePromptId(promptId: string): string {
  return promptId.replace(/__run_[1-9][0-9]*$/u, "");
}

function caseRunRoot(
  root: string,
  promptId: string,
  revision: BtccRevision,
): string {
  return join(
    root,
    promptId.replace(/[^A-Za-z0-9._-]+/gu, "-"),
    `${revision}-${Date.now()}-${randomUUID().slice(0, 8)}`,
  );
}

function readHarnessEvidence(runRoot: string): Record<string, unknown> {
  const path = join(runRoot, "evidence.json");
  if (!existsSync(path)) return { run: { runRoot }, observations: [] };
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function isProductTimeout(error: unknown): boolean {
  return errorMessage(error).includes("Timed out waiting for Electron Turn after");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function observationKey(promptId: string, revision: BtccRevision): string {
  return `${promptId}:${revision}`;
}

function accessMode(value: string): "ask_first" | "full_access" | "read_only" {
  if (value === "ask_first" || value === "full_access" || value === "read_only") {
    return value;
  }
  throw new Error(`Unsupported benchmark access mode: ${value}`);
}

function reasoningEffort(
  value: string,
): "high" | "low" | "max" | "medium" | "none" | "xhigh" {
  if (
    value === "high" || value === "low" || value === "max" ||
    value === "medium" || value === "none" || value === "xhigh"
  ) return value;
  throw new Error(`Unsupported benchmark reasoning effort: ${value}`);
}

function verifyTargetCheckouts(
  targets: BenchmarkEvidenceFile["plan"]["targets"],
): void {
  for (const target of Object.values(targets)) {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: target.worktreePath,
      encoding: "utf8",
    }).trim();
    if (head !== target.commit) {
      throw new Error(
        `Benchmark ${target.revision} checkout is ${head}, expected ${target.commit}`,
      );
    }
    const status = execFileSync("git", ["status", "--short"], {
      cwd: target.worktreePath,
      encoding: "utf8",
    }).trim();
    if (status) {
      throw new Error(`Benchmark ${target.revision} checkout is not clean`);
    }
  }
}
