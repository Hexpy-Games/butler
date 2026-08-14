import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createProductionAgentAdapters } from "./adapters.ts";
import type { AdapterRunFailure, BenchmarkArmPlan, BenchmarkPlan } from "./contracts.ts";
import { getBenchmarkFixture } from "./fixtures.ts";
import { benchmarkPlanIdentity } from "./planning.ts";
import {
  preparedResourceIdentity,
  type PreparedButlerResourceReference,
} from "./prepared-butler-resource.ts";
import {
  hasUnsafeButlerRuntimeDirectoryComponent,
  isStrictlyInsideButlerRuntime,
} from "./butler-runtime-path-safety.ts";
import { FINAL_ACTIVATION } from "./paired-contract.ts";

const MAX_PREFLIGHT_RECEIPT_BYTES = 16 * 1024;
type PreflightVersion = "before" | "after";

interface PairedLaunchSmokeFailure extends Omit<AdapterRunFailure, "schema"> {
  schema: "butler.paired-launch-smoke-failure.v1";
  planIdentity: string;
  version: PreflightVersion;
}

class PairedLaunchSmokePreflightError extends Error {
  readonly failure: PairedLaunchSmokeFailure;

  constructor(failure: PairedLaunchSmokeFailure) {
    super(`Paired Butler launch-smoke preflight failed: ${JSON.stringify(failure)}`);
    this.name = "PairedLaunchSmokePreflightError";
    this.failure = failure;
  }
}

interface PreparedPreflightArm {
  version: PreflightVersion;
  arm: BenchmarkArmPlan;
  preflightRoot: string;
  receiptPath: string;
  receiptText: string;
  preflightArm: BenchmarkArmPlan;
  state: "fresh" | "resumed";
}

export async function runPairedLaunchSmokePreflight(input: {
  plan: BenchmarkPlan;
  createAdapters: typeof createProductionAgentAdapters;
  preparedButlerResources: Readonly<Record<"before" | "after", PreparedButlerResourceReference>>;
  pairedExecution: NonNullable<BenchmarkPlan["pairedCampaign"]>["execution"];
}): Promise<{ kind: "paired_launch_smoke_preflight"; launchSmokes: 2; providerRequests: 0 }> {
  const arms = (["before", "after"] as const).map((version) => {
    const arm = input.plan.arms.find((candidate) => candidate.version === version);
    if (!arm) throw new Error(`Paired launch-smoke ${version} arm was unavailable.`);
    return preparePreflightArm(input, version, arm);
  });

  const adapters = input.createAdapters(input.plan.sourceRoot, {
    rendererStartSmoke: true,
    pairedPreparedButlerResources: input.preparedButlerResources,
    pairedExecution: input.pairedExecution,
  });
  const preflight = await adapters.butler.preflight();
  if (preflight.gateCode !== "none" || !preflight.available || !preflight.configVerified) {
    throw new Error("Paired Butler launch-smoke preflight was unavailable.");
  }
  const controller = new AbortController();
  for (const prepared of arms) {
    if (prepared.state === "resumed") continue;
    assertSafeDerivedPreflightPaths(input.plan.runRoot, prepared);
    if (optionalLstat(prepared.preflightRoot)) {
      throw new Error(`Paired Butler ${prepared.version} launch-smoke root was not fresh.`);
    }
    const fixture = getBenchmarkFixture(prepared.arm.scenario, input.plan.harnessRoot);
    const result = await adapters.butler.run({
      arm: prepared.preflightArm,
      fixture,
      prompt: fixture.prompts[0] ?? "",
      sessionId: null,
      sourceEvidenceRoot: "",
      runtimeInstructions: "Provider-free renderer launch preflight; do not dispatch a Turn.",
      signal: controller.signal,
      benchmarkEvidence: { planIdentity: benchmarkPlanIdentity(input.plan), runRoot: input.plan.runRoot },
    });
    if (result.exitCode !== 0 || result.gateCode !== "none" ||
        result.providerDispatchState !== "adapter_entered" || result.m1V2Evidence !== undefined) {
      if (result.failure) {
        const failure: PairedLaunchSmokeFailure = {
          ...result.failure,
          schema: "butler.paired-launch-smoke-failure.v1",
          planIdentity: benchmarkPlanIdentity(input.plan),
          version: prepared.version,
        };
        throw new PairedLaunchSmokePreflightError(failure);
      }
      throw new Error(`Paired Butler ${prepared.version} launch-smoke preflight failed.`);
    }
    assertSafeDerivedPreflightPaths(input.plan.runRoot, prepared);
    assertSuccessfulEvidenceState(prepared);
    if (optionalLstat(prepared.receiptPath)) {
      throw new Error(`Paired Butler ${prepared.version} launch-smoke receipt already existed.`);
    }
    mkdirSync(prepared.preflightRoot, { recursive: true });
    assertSafeDerivedPreflightPaths(input.plan.runRoot, prepared);
    writeFileSync(prepared.receiptPath, prepared.receiptText, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }
  return { kind: "paired_launch_smoke_preflight", launchSmokes: 2, providerRequests: 0 };
}

function preparePreflightArm(
  input: Parameters<typeof runPairedLaunchSmokePreflight>[0],
  version: PreflightVersion,
  arm: BenchmarkArmPlan,
): PreparedPreflightArm {
  const preflightRoot = join(input.plan.runRoot, "preflight", "launch-smoke", version);
  const receiptPath = join(preflightRoot, "receipt.json");
  const preflightArm = {
    ...arm,
    evidenceRoot: join(preflightRoot, "evidence"),
    outputRoot: join(preflightRoot, "output"),
    cacheRoot: join(preflightRoot, "cache"),
    dataRoot: join(preflightRoot, "benchmark-data"),
  };
  const receiptText = `${JSON.stringify({
    schema: "butler.paired-launch-smoke-preflight.v1",
    planIdentity: benchmarkPlanIdentity(input.plan),
    armKey: arm.key,
    fixtureHash: arm.fixtureHash,
    sourceRevision: arm.sourceRevision,
    activation: arm.activation,
    preparedResourceIdentity: preparedResourceIdentity(input.preparedButlerResources[version]),
    version,
    operationKind: "launch_smoke",
    launches: 2,
    actualProductPath: [
      "electron_renderer",
      "electron_preload_bridge",
      "app_gateway",
      "native_btcc_runtime",
    ],
    providerRequests: 0,
    turnObservations: 0,
  }, null, 2)}\n`;
  const prepared = { version, arm, preflightRoot, receiptPath, receiptText, preflightArm };
  if (JSON.stringify(arm.activation) !== JSON.stringify(FINAL_ACTIVATION[version])) {
    throw new Error(`Paired Butler ${version} launch-smoke activation identity was invalid.`);
  }
  assertSafeDerivedPreflightPaths(input.plan.runRoot, prepared);
  const rootStat = optionalLstat(preflightRoot);
  if (!rootStat) return { ...prepared, state: "fresh" };
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Paired Butler ${version} launch-smoke root was unsafe.`);
  }
  validateExistingReceipt(prepared);
  return { ...prepared, state: "resumed" };
}

function validateExistingReceipt(prepared: Omit<PreparedPreflightArm, "state">): void {
  const stat = optionalLstat(prepared.receiptPath);
  if (!stat) {
    throw new Error(`Paired Butler ${prepared.version} launch-smoke root was partial.`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== Buffer.byteLength(prepared.receiptText) ||
      stat.size <= 0 || stat.size > MAX_PREFLIGHT_RECEIPT_BYTES || (Number(stat.mode) & 0o777) !== 0o600) {
    throw new Error(`Paired Butler ${prepared.version} launch-smoke receipt was unsafe.`);
  }
  if (readFileSync(prepared.receiptPath, "utf8") !== prepared.receiptText) {
    throw new Error(`Paired Butler ${prepared.version} launch-smoke receipt was invalid.`);
  }
  assertSuccessfulEvidenceState(prepared);
}

function assertSuccessfulEvidenceState(prepared: Omit<PreparedPreflightArm, "state">): void {
  const evidenceStat = optionalLstat(prepared.preflightArm.evidenceRoot);
  if (!evidenceStat?.isDirectory() || evidenceStat.isSymbolicLink() ||
      optionalLstat(join(prepared.preflightArm.evidenceRoot, "data")) ||
      optionalLstat(join(prepared.preflightArm.evidenceRoot, "sc01-public-evidence.json"))) {
    throw new Error(`Paired Butler ${prepared.version} launch-smoke preflight failed.`);
  }
}

function assertSafeDerivedPreflightPaths(
  runRoot: string,
  prepared: Pick<PreparedPreflightArm, "preflightRoot" | "receiptPath" | "preflightArm" | "version">,
): void {
  const directoryPaths = [
    dirname(prepared.preflightRoot),
    prepared.preflightRoot,
    prepared.preflightArm.evidenceRoot,
    prepared.preflightArm.outputRoot,
    prepared.preflightArm.cacheRoot,
    prepared.preflightArm.dataRoot,
  ];
  const allPaths = [...directoryPaths, prepared.receiptPath,
    join(prepared.preflightArm.evidenceRoot, "data"),
    join(prepared.preflightArm.evidenceRoot, "sc01-public-evidence.json")];
  if (allPaths.some((path) => !isStrictlyInsideButlerRuntime(runRoot, path)) ||
      directoryPaths.some(hasUnsafeButlerRuntimeDirectoryComponent) ||
      hasUnsafeButlerRuntimeDirectoryComponent(dirname(prepared.receiptPath))) {
    throw new Error(`Paired Butler ${prepared.version} launch-smoke path was unsafe.`);
  }
  const runReal = optionalRealpath(runRoot);
  if (!runReal) return;
  for (const path of directoryPaths) {
    const pathReal = optionalRealpath(path);
    if (pathReal && !isStrictlyInsideButlerRuntime(runReal, pathReal)) {
      throw new Error(`Paired Butler ${prepared.version} launch-smoke path escaped its run root.`);
    }
  }
}

function optionalLstat(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  }
}

function optionalRealpath(path: string): string | null {
  try {
    return resolve(realpathSync(path));
  } catch (error) {
    if (error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  }
}
