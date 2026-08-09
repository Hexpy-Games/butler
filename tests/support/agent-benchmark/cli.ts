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
  type BenchmarkCheckpointStore,
} from "./workflow.ts";
import type { BenchmarkResultFile } from "./contracts.ts";
import { sanitizeIdentifier } from "./identifiers.ts";
import { applyVisualReviews, readVisualReviewFile } from "./visual-review.ts";
import { assertNoSymlinkComponents } from "./isolation.ts";

export interface AgentBenchmarkCliOptions {
  command: "plan" | "pilot" | "run";
  runRoot: string;
  sourceRoot: string;
  outputDirectory: string;
  seed: number;
  runId: string;
  executeAvailable: boolean;
  controlledModel: string;
  controlledReasoning: string;
  visualReviewPath: string | null;
}

const CANONICAL_PILOT_MODEL = "openai/gpt-5.6-sol";
const CANONICAL_PILOT_REASONING = "medium";

export async function runAgentBenchmarkCli(argv: readonly string[]): Promise<string> {
  const options = parseOptions(argv);
  const plan = createBenchmarkPlan({
    runId: options.runId,
    seed: options.seed,
    runRoot: options.runRoot,
    sourceRoot: options.sourceRoot,
    controlledModel: options.controlledModel,
    controlledReasoning: options.controlledReasoning,
  });
  const planPath = join(options.runRoot, "plan.json");
  const resultPath = join(options.runRoot, "result.json");
  const store = createFileCheckpointStore(resultPath);
  if (options.command === "plan") {
    await writeJson(store, planPath, redactBenchmarkPlan(plan));
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
    baselineSha: AGENT_BENCHMARK_BASELINE_SHA,
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
  const runRoot = resolve(option(argv, "--run-root") ?? mkdtempSync(join(tmpdir(), "butler-agent-benchmark-")));
  const outputDirectory = resolve(option(argv, "--output") ?? join(runRoot, "report"));
  if (!insideRoot(runRoot, outputDirectory)) throw new Error("--output must remain inside --run-root");
  assertNoSymlinkComponents(runRoot);
  assertNoSymlinkComponents(outputDirectory);
  const controlledModel = option(argv, "--controlled-model");
  if (!controlledModel) throw new Error("Missing required option: --controlled-model");
  const controlledReasoning = option(argv, "--controlled-reasoning") ?? CANONICAL_PILOT_REASONING;
  if (command === "pilot" && (controlledModel.trim() !== CANONICAL_PILOT_MODEL || controlledReasoning.trim() !== CANONICAL_PILOT_REASONING)) {
    throw new Error(`The canonical pilot requires ${CANONICAL_PILOT_MODEL} with ${CANONICAL_PILOT_REASONING} reasoning`);
  }
  return {
    command,
    runRoot,
    sourceRoot,
    outputDirectory,
    seed,
    runId,
    executeAvailable: argv.includes("--execute-available"),
    controlledModel,
    controlledReasoning,
    visualReviewPath: option(argv, "--visual-review") ?? null,
  };
}

function validateFlags(argv: readonly string[]): void {
  const valueFlags = new Set(["--seed", "--run-id", "--source-root", "--run-root", "--output", "--controlled-model", "--controlled-reasoning", "--visual-review"]);
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

async function writeJson(store: BenchmarkCheckpointStore, path: string, value: unknown): Promise<void> {
  const temporaryStore = createFileCheckpointStore(path);
  if (isBenchmarkResult(value)) await temporaryStore.save(value);
  else {
    const fs = await import("node:fs/promises");
    await fs.mkdir(resolve(path, ".."), { recursive: true });
    await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
  void store;
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function insideRoot(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

function isBenchmarkResult(value: unknown): value is BenchmarkResultFile {
  return Boolean(value && typeof value === "object" && (value as { kind?: unknown }).kind === "agent_benchmark_result");
}

if (import.meta.main) {
  runAgentBenchmarkCli(process.argv.slice(2))
    .then((output) => console.log(output))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
