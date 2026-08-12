import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createProductionAgentAdapters } from "./adapters.ts";
import { AGENT_BENCHMARK_BASELINE_SHA } from "./contracts.ts";
import { createBenchmarkPlan } from "./planning.ts";
import { writeBenchmarkReport } from "./report.ts";
import { validateLandingWorkspace } from "./landing-validation.ts";
import {
  createFileCheckpointStore,
  redactBenchmarkPlan,
  runAgentBenchmark,
} from "./workflow.ts";
import type { BenchmarkPlan, BenchmarkResultFile } from "./contracts.ts";
import { sanitizeIdentifier } from "./identifiers.ts";
import { applyVisualReviews, readVisualReviewFile } from "./visual-review.ts";
import { assertNoSymlinkComponents } from "./isolation.ts";

export interface AgentBenchmarkCliOptions {
  command: "plan" | "pilot" | "run";
  runRoot: string;
  sourceRoot: string;
  harnessRoot: string;
  provenanceJsonlPath: string | null;
  outputDirectory: string;
  seed: number;
  runId: string;
  executeAvailable: boolean;
  controlledModel: string;
  controlledReasoning: string;
  visualReviewPath: string | null;
  campaign: "cross-agent-pilot" | "m1-v2";
  repetitions: number;
  sourceRevision: string;
}

const CANONICAL_PILOT_MODEL = "openai/gpt-5.6-sol";
const CANONICAL_PILOT_REASONING = "medium";

export async function runAgentBenchmarkCli(argv: readonly string[]): Promise<string> {
  const options = parseOptions(argv);
  const proposedPlan = createBenchmarkPlan({
    campaign: options.campaign,
    runId: options.runId,
    seed: options.seed,
    runRoot: options.runRoot,
    sourceRoot: options.sourceRoot,
    harnessRoot: options.harnessRoot,
    provenanceJsonlPath: options.provenanceJsonlPath ?? undefined,
    controlledModel: options.controlledModel,
    controlledReasoning: options.controlledReasoning,
    repetitionsPerCache: options.repetitions,
    baselineSha: options.sourceRevision,
  });
  const planPath = join(options.runRoot, "manifest.json");
  const resultPath = join(options.runRoot, "result.json");
  const store = createFileCheckpointStore(resultPath);
  const plan = await persistBenchmarkManifest(planPath, proposedPlan);
  if (options.command === "plan") {
    return JSON.stringify({ planPath: relative(plan.runRoot, planPath), runId: plan.runId, seed: plan.seed, arms: plan.arms.length });
  }
  const adapters = createProductionAgentAdapters(options.sourceRoot);
  const controller = new AbortController();
  const completed = await runAgentBenchmark({
    plan,
    adapters,
    store,
    signal: controller.signal,
    landingValidator: validateLandingWorkspace,
    mode: options.command === "pilot" && !options.executeAvailable ? "preflight-only" : "execute",
  });
  let result: BenchmarkResultFile = completed.result;
  if (options.visualReviewPath) {
    result = applyVisualReviews(result, readVisualReviewFile(options.visualReviewPath));
    await store.save(result);
  }
  const reportPaths = writeBenchmarkReport(result, options.outputDirectory);
  return JSON.stringify({
    runId: result.run.runId,
    baselineSha: plan.baselineSha,
    resultPath: relative(plan.runRoot, resultPath),
    reportPath: relative(plan.runRoot, reportPaths.markdownPath),
    gates: result.observations.filter((observation) => observation.terminalState === "gated").length,
  });
}

export function parseOptions(argv: readonly string[]): AgentBenchmarkCliOptions {
  const command = argv[0];
  if (command !== "plan" && command !== "run" && command !== "pilot") throw new Error("Unknown benchmark command. Use plan, run, or pilot.");
  validateFlags(argv);
  const seedText = option(argv, "--seed");
  if (!seedText) throw new Error("Missing required option: --seed");
  const seed = Number(seedText);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw new Error("--seed must be an unsigned 32-bit integer");
  const runId = sanitizeIdentifier(option(argv, "--run-id") ?? `agent-benchmark-${seed}`);
  if (!runId) throw new Error("--run-id must be a safe benchmark identifier");
  const sourceRoot = resolve(option(argv, "--source-root") ?? process.cwd());
  const harnessRootOption = option(argv, "--harness-root");
  const harnessRoot = resolve(harnessRootOption ?? process.cwd());
  const runRoot = resolve(option(argv, "--run-root") ?? mkdtempSync(join(tmpdir(), "butler-agent-benchmark-")));
  const outputDirectory = resolve(option(argv, "--output") ?? join(runRoot, "report"));
  if (!insideRoot(runRoot, outputDirectory)) throw new Error("--output must remain inside --run-root");
  assertNoSymlinkComponents(runRoot);
  assertNoSymlinkComponents(outputDirectory);
  const controlledModel = option(argv, "--controlled-model");
  if (!controlledModel) throw new Error("Missing required option: --controlled-model");
  const controlledReasoning = option(argv, "--controlled-reasoning") ?? CANONICAL_PILOT_REASONING;
  const campaign = option(argv, "--campaign") ?? "cross-agent-pilot";
  if (campaign !== "cross-agent-pilot" && campaign !== "m1-v2") throw new Error("--campaign must be cross-agent-pilot or m1-v2");
  if (campaign === "m1-v2" && !harnessRootOption) {
    throw new Error("Missing required M1 v2 option: --harness-root");
  }
  const repetitions = Number(option(argv, "--repetitions") ?? (campaign === "m1-v2" ? "3" : "1"));
  const sourceRevision = option(argv, "--source-revision") ?? AGENT_BENCHMARK_BASELINE_SHA;
  if (command === "pilot" && (controlledModel.trim() !== CANONICAL_PILOT_MODEL || controlledReasoning.trim() !== CANONICAL_PILOT_REASONING)) {
    throw new Error(`The canonical pilot requires ${CANONICAL_PILOT_MODEL} with ${CANONICAL_PILOT_REASONING} reasoning`);
  }
  return {
    command,
    runRoot,
    sourceRoot,
    harnessRoot,
    provenanceJsonlPath: option(argv, "--provenance-jsonl")
      ? resolve(option(argv, "--provenance-jsonl")!)
      : null,
    outputDirectory,
    seed,
    runId,
    executeAvailable: argv.includes("--execute-available"),
    controlledModel,
    controlledReasoning,
    visualReviewPath: option(argv, "--visual-review") ?? null,
    campaign,
    repetitions,
    sourceRevision,
  };
}

function validateFlags(argv: readonly string[]): void {
  const valueFlags = new Set(["--seed", "--run-id", "--source-root", "--harness-root", "--provenance-jsonl", "--run-root", "--output", "--controlled-model", "--controlled-reasoning", "--visual-review", "--campaign", "--repetitions", "--source-revision"]);
  const booleanFlags = new Set(["--execute-available"]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!flag.startsWith("--") || (!valueFlags.has(flag) && !booleanFlags.has(flag))) throw new Error(`Unknown benchmark option: ${flag}`);
    if (valueFlags.has(flag)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
      index += 1;
    }
  }
}

async function persistBenchmarkManifest(
  path: string,
  plan: BenchmarkPlan,
): Promise<BenchmarkPlan> {
  const fs = await import("node:fs/promises");
  const desired = redactBenchmarkPlan(plan);
  const desiredText = `${JSON.stringify(desired, null, 2)}\n`;
  await fs.mkdir(resolve(path, ".."), { recursive: true });
  try {
    await fs.writeFile(path, desiredText, { encoding: "utf8", flag: "wx" });
    return plan;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  let existing: BenchmarkPlan;
  try {
    existing = JSON.parse(await fs.readFile(path, "utf8")) as BenchmarkPlan;
  } catch {
    throw new Error("Benchmark manifest identity mismatch: existing manifest is unreadable.");
  }
  if (typeof existing.createdAt !== "string") {
    throw new Error("Benchmark manifest identity mismatch: creation time is invalid.");
  }
  const comparable = { ...existing, createdAt: desired.createdAt };
  if (JSON.stringify(comparable) !== JSON.stringify(desired)) {
    throw new Error("Benchmark manifest identity mismatch: replacement runs are not allowed.");
  }
  return { ...plan, createdAt: existing.createdAt };
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function insideRoot(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" &&
    (error as { code?: unknown }).code === "EEXIST");
}

if (import.meta.main) {
  runAgentBenchmarkCli(process.argv.slice(2))
    .then((output) => console.log(output))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
