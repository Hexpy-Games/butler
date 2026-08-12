import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createProductionAgentAdapters } from "./adapters.ts";
import { createProcessExecutor, type CommandExecutor } from "./command.ts";
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
import { assertNoSymlinkComponents, assertPairedRootIsolation } from "./isolation.ts";
import {
  readPreparedButlerResourceReference,
  preparedResourceIdentity,
  type PreparedButlerResourceReference,
} from "./prepared-butler-resource.ts";
import { hashBenchmarkFixture, loadM1V2BenchmarkFixtures } from "./fixtures.ts";
import { runPairedLaunchSmokePreflight } from "./paired-launch-smoke-preflight.ts";
import { verifyM1V2AuthoritativeProvenance } from "./m1-v2-provenance.ts";
import {
  createPairedCampaignContract,
  FINAL_AFTER_REVISION,
  FINAL_BEFORE_REVISION,
  requireAvailableProviderAuth,
} from "./paired-contract.ts";
import { observeProviderAuthPreflight } from "./provider-auth-preflight.ts";
export interface AgentBenchmarkCliOptions {
  command: "plan" | "pilot" | "preflight" | "run";
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
  campaign: "cross-agent-pilot" | "m1-v2" | "m1-v2-paired";
  repetitions: number;
  sourceRevision: string;
  preparedButlerResource: PreparedButlerResourceReference | null;
  pairedSourceRoots: Readonly<Record<"before" | "after", string>> | null;
  pairedPreparedButlerResources: Readonly<Record<"before" | "after", PreparedButlerResourceReference>> | null;
}
const CANONICAL_PILOT_MODEL = "openai/gpt-5.6-sol";
const CANONICAL_PILOT_REASONING = "medium";
export async function runAgentBenchmarkCli(argv: readonly string[], composition: {
  createAdapters?: typeof createProductionAgentAdapters;
  landingValidator?: typeof validateLandingWorkspace;
  preflightExecutor?: CommandExecutor;
  preflightEnvironment?: NodeJS.ProcessEnv;
} = {}): Promise<string> {
  const options = parseOptions(argv);
  const authReceipt = options.campaign === "m1-v2-paired"
    ? await observeProviderAuthPreflight(composition.preflightExecutor ?? createProcessExecutor(), options.sourceRoot,
        composition.preflightEnvironment ?? process.env) : null;
  const pairedExecution = options.campaign === "m1-v2-paired"
    ? requireAvailableProviderAuth(authReceipt!)
    : null;
  const pairedCampaign = options.campaign === "m1-v2-paired"
    ? createPairedCampaignContract({
        before: {
          version: "before", revision: FINAL_BEFORE_REVISION,
          compatibilitySha256: options.pairedPreparedButlerResources!.before.sourceCompatibilitySha256,
          platform: `${process.platform}-${process.arch}`, mode: "bundled_agent_release",
          preparedResource: preparedResourceIdentity(options.pairedPreparedButlerResources!.before),
        },
        after: {
          version: "after", revision: FINAL_AFTER_REVISION,
          compatibilitySha256: options.pairedPreparedButlerResources!.after.sourceCompatibilitySha256,
          platform: `${process.platform}-${process.arch}`, mode: "bundled_agent_release",
          preparedResource: preparedResourceIdentity(options.pairedPreparedButlerResources!.after),
        },
        execution: pairedExecution!,
        authReceipt: authReceipt!,
        fixtureHashes: Object.fromEntries(loadM1V2BenchmarkFixtures(options.harnessRoot)
          .map((fixture) => [fixture.id, hashBenchmarkFixture(fixture)])) as Record<"direct-cold" | "direct-warm" | "current-web-cold" | "landing-cold", string>,
        provenance: verifyM1V2AuthoritativeProvenance({
          repoRoot: options.harnessRoot,
          jsonlPath: options.provenanceJsonlPath!,
        }).identity,
      })
    : undefined;
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
    preparedButlerResource: options.preparedButlerResource
      ? preparedResourceIdentity(options.preparedButlerResource)
      : undefined,
    pairedCampaign,
    pairedRuntimeSources: options.pairedSourceRoots ?? undefined,
  });
  const planPath = join(options.runRoot, "manifest.json");
  const resultPath = join(options.runRoot, "result.json");
  const store = createFileCheckpointStore(resultPath);
  if (options.command === "preflight") {
    if (options.campaign !== "m1-v2-paired") {
      throw new Error("The provider-free launch preflight is available only for the paired M1 campaign.");
    }
    const result = await runPairedLaunchSmokePreflight({
      plan: proposedPlan,
      createAdapters: composition.createAdapters ?? createProductionAgentAdapters,
      preparedButlerResources: options.pairedPreparedButlerResources!,
      pairedExecution: pairedExecution!,
    });
    return JSON.stringify(result);
  }
  const plan = await persistBenchmarkManifest(planPath, proposedPlan);
  if (options.command === "plan") {
    return JSON.stringify({ planPath: relative(plan.runRoot, planPath), runId: plan.runId, seed: plan.seed, arms: plan.arms.length });
  }
  const adapters = (composition.createAdapters ?? createProductionAgentAdapters)(options.sourceRoot, {
    ...(options.preparedButlerResource
      ? { preparedButlerResource: options.preparedButlerResource }
      : {}),
    ...(options.pairedPreparedButlerResources
      ? { pairedPreparedButlerResources: options.pairedPreparedButlerResources }
      : {}),
    ...(pairedExecution ? { pairedExecution } : {}),
  });
  const controller = new AbortController();
  const completed = await runAgentBenchmark({
    plan,
    adapters,
    store,
    signal: controller.signal,
    landingValidator: composition.landingValidator ?? validateLandingWorkspace,
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
  if (command !== "plan" && command !== "run" && command !== "pilot" && command !== "preflight") {
    throw new Error("Unknown benchmark command. Use plan, preflight, run, or pilot.");
  }
  validateFlags(argv);
  const seedText = option(argv, "--seed");
  if (!seedText) throw new Error("Missing required option: --seed");
  const seed = Number(seedText);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw new Error("--seed must be an unsigned 32-bit integer");
  const runId = sanitizeIdentifier(option(argv, "--run-id") ?? `agent-benchmark-${seed}`);
  if (!runId) throw new Error("--run-id must be a safe benchmark identifier");
  let sourceRoot = resolve(option(argv, "--source-root") ?? process.cwd());
  const harnessRootOption = option(argv, "--harness-root");
  const harnessRoot = resolve(harnessRootOption ?? process.cwd());
  const runRootOption = option(argv, "--run-root");
  if (campaignOption(argv) === "m1-v2-paired" && !runRootOption)
    throw new Error("The paired campaign requires an explicit durable --run-root");
  const runRoot = resolve(runRootOption ?? mkdtempSync(join(tmpdir(), "butler-agent-benchmark-")));
  const outputDirectory = resolve(option(argv, "--output") ?? join(runRoot, "report"));
  if (!insideRoot(runRoot, outputDirectory)) throw new Error("--output must remain inside --run-root");
  if (campaignOption(argv) === "m1-v2-paired" && insideRoot(tmpdir(), runRoot))
    throw new Error("The paired --run-root must be durable and outside the private temporary root");
  assertNoSymlinkComponents(runRoot);
  assertNoSymlinkComponents(outputDirectory);
  const controlledModel = option(argv, "--controlled-model");
  if (!controlledModel) throw new Error("Missing required option: --controlled-model");
  const controlledReasoning = option(argv, "--controlled-reasoning") ?? CANONICAL_PILOT_REASONING;
  const campaign = option(argv, "--campaign") ?? "cross-agent-pilot";
  if (campaign !== "cross-agent-pilot" && campaign !== "m1-v2" && campaign !== "m1-v2-paired") throw new Error("--campaign must be cross-agent-pilot, m1-v2, or m1-v2-paired");
  if (campaign !== "cross-agent-pilot" && !harnessRootOption) {
    throw new Error("Missing required M1 v2 option: --harness-root");
  }
  const repetitions = Number(option(argv, "--repetitions") ?? (campaign !== "cross-agent-pilot" ? "3" : "1"));
  const sourceRevision = option(argv, "--source-revision") ?? AGENT_BENCHMARK_BASELINE_SHA;
  const preparedPinPath = option(argv, "--prepared-butler-resource-pin");
  const preparedButlerResource = preparedPinPath
    ? readPreparedButlerResourceReference(resolve(preparedPinPath))
    : null;
  const pairedSourceRoots = campaign === "m1-v2-paired" ? {
    before: resolve(requiredOption(argv, "--before-source-root")),
    after: resolve(requiredOption(argv, "--after-source-root")),
  } : null;
  if (pairedSourceRoots) sourceRoot = pairedSourceRoots.after;
  const pairedPreparedButlerResources = campaign === "m1-v2-paired" ? {
    before: readPreparedButlerResourceReference(resolve(requiredOption(argv, "--before-prepared-butler-resource-pin"))),
    after: readPreparedButlerResourceReference(resolve(requiredOption(argv, "--after-prepared-butler-resource-pin"))),
  } : null;
  if (pairedSourceRoots && pairedPreparedButlerResources) {
    assertPairedRootIsolation(runRoot, harnessRoot, pairedSourceRoots.before, pairedSourceRoots.after,
      pairedPreparedButlerResources.before.resourceDir, pairedPreparedButlerResources.after.resourceDir);
  }
  if (campaign === "m1-v2-paired" &&
      (controlledModel !== CANONICAL_PILOT_MODEL || controlledReasoning !== CANONICAL_PILOT_REASONING ||
       sourceRevision !== FINAL_AFTER_REVISION || repetitions !== 3)) {
    throw new Error("The final paired campaign requires exact after revision, 3 repetitions, and ordinary openai/gpt-5.6-sol medium.");
  }
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
    preparedButlerResource,
    pairedSourceRoots,
    pairedPreparedButlerResources,
  };
}

function validateFlags(argv: readonly string[]): void {
  const valueFlags = new Set(["--seed", "--run-id", "--source-root", "--harness-root", "--provenance-jsonl", "--run-root", "--output", "--controlled-model", "--controlled-reasoning", "--visual-review", "--campaign", "--repetitions", "--source-revision", "--prepared-butler-resource-pin", "--before-source-root", "--after-source-root", "--before-prepared-butler-resource-pin", "--after-prepared-butler-resource-pin"]);
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
function requiredOption(argv: readonly string[], name: string): string {
  const value = option(argv, name);
  if (!value) throw new Error(`Missing required paired option: ${name}`);
  return value;
}
const campaignOption = (argv: readonly string[]): string => option(argv, "--campaign") ?? "cross-agent-pilot";
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
