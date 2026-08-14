import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { BenchmarkPlan } from "./contracts.ts";
import { AGENT_BENCHMARK_BASELINE_SHA, AGENT_BENCHMARK_SCHEMA } from "./contracts.ts";

export function validateBenchmarkPlan(plan: BenchmarkPlan): void {
  if (plan.schema !== AGENT_BENCHMARK_SCHEMA || plan.kind !== "agent_benchmark_plan") throw new Error("Agent benchmark plan schema mismatch");
  if (!/^[a-f0-9]{40}$/u.test(plan.baselineSha)) throw new Error(`Agent benchmark source revision is not an exact SHA: ${plan.baselineSha}`);
  if (plan.campaign === "cross-agent-pilot" && plan.baselineSha !== AGENT_BENCHMARK_BASELINE_SHA) {
    throw new Error(`Agent benchmark baseline mismatch: ${plan.baselineSha}`);
  }
  if (!Number.isSafeInteger(plan.seed)) throw new Error("Agent benchmark seed is required");
  const runRoot = resolve(plan.runRoot);
  const sourceRoot = resolve(plan.sourceRoot);
  const harnessRoot = resolve(plan.harnessRoot);
  assertNoSymlinkComponents(runRoot);
  assertNoSymlinkComponents(sourceRoot);
  assertNoSymlinkComponents(harnessRoot);
  if (runRoot === sourceRoot || inside(sourceRoot, runRoot) || inside(runRoot, sourceRoot)) throw new Error("Benchmark run root and source root must be isolated");
  if (runRoot === harnessRoot || inside(harnessRoot, runRoot) || inside(runRoot, harnessRoot)) throw new Error("Benchmark run root and harness authority root must be isolated");
  if ((plan.campaign === "m1-v2" || plan.campaign === "m1-v2-paired" || plan.campaign === "m1-v2-after-only") && (!plan.provenanceJsonlPath ||
    plan.provenance?.schema !== "butler.agent-benchmark.provenance-identity.v1" ||
    ![plan.provenance.metadataSha256, plan.provenance.jsonlSha256, plan.provenance.verifiedSha256]
      .every((value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)))) {
    throw new Error("M1 v2 provenance identity is missing or invalid");
  }
  if (plan.preparedButlerResource && (
    !/^[a-f0-9]{40}$/u.test(plan.preparedButlerResource.sourceRevision) ||
    ![
      plan.preparedButlerResource.sourceCompatibilitySha256,
      plan.preparedButlerResource.manifestSha256,
      plan.preparedButlerResource.dependencyClosureSha256,
      plan.preparedButlerResource.resourceSha256,
      plan.preparedButlerResource.archiveSha256,
    ].every((value) => /^[a-f0-9]{64}$/u.test(value)) ||
    !Number.isSafeInteger(plan.preparedButlerResource.archiveBytes) ||
    plan.preparedButlerResource.archiveBytes <= 0 ||
    !Number.isSafeInteger(plan.preparedButlerResource.resourceBytes) ||
    plan.preparedButlerResource.resourceBytes <= 0
  )) throw new Error("Prepared Butler resource plan identity is invalid");
  const fixtureHashes = new Map(plan.fixtures.map((fixture) => [fixture.id, fixture.sha256]));
  if (plan.campaign === "m1-v2-paired" &&
      (plan.pairedCampaign?.steps.length !== 24 || plan.arms.length !== 24)) {
    throw new Error("Paired M1 plan must contain exactly 24 immutable steps");
  }
  if (plan.campaign === "m1-v2-after-only" &&
      (plan.afterOnlyCampaign?.steps.length !== 12 || plan.arms.length !== 12)) {
    throw new Error("AFTER-only M1 plan must contain exactly 12 immutable AFTER steps");
  }
  for (const arm of plan.arms) {
    if (arm.fixtureHash !== fixtureHashes.get(arm.scenario)) throw new Error(`Fixture hash mismatch for arm ${arm.key}`);
    for (const path of [arm.outputRoot, arm.dataRoot, arm.evidenceRoot, arm.cacheRoot]) {
      if (!inside(runRoot, resolve(path))) throw new Error(`Arm path escapes run root: ${path}`);
    }
    assertNoSymlinkComponents(resolve(arm.sourceRoot));
    if (plan.campaign !== "m1-v2-paired" && plan.campaign !== "m1-v2-after-only") {
      if (resolve(arm.sourceRoot) !== sourceRoot) throw new Error(`Arm source root mismatch: ${arm.key}`);
      if (arm.sourceRevision !== plan.baselineSha) throw new Error(`Arm source revision mismatch: ${arm.key}`);
    } else {
      const step = plan.campaign === "m1-v2-paired"
        ? plan.pairedCampaign?.steps[arm.order]
        : plan.afterOnlyCampaign?.steps[arm.order];
      if (!step || arm.key !== step.key || arm.version !== step.version ||
          arm.pairId !== step.pairId || arm.block !== step.block ||
          arm.sourceRevision !== step.source.revision) {
        throw new Error(`Paired arm identity mismatch: ${arm.key}`);
      }
    }
  }
}

export function assertPairedRootIsolation(...inputRoots: string[]): void {
  const roots = inputRoots.map((root) => resolve(root));
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      const a = roots[left]!, b = roots[right]!;
      if (a === b || inside(a, b) || inside(b, a)) {
        throw new Error("Paired run, harness, before source, after source, and prepared resource roots must be distinct and non-overlapping");
      }
    }
  }
}

export function assertNoSymlinkComponents(path: string): void {
  const resolved = resolve(path);
  const parsed = parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink() && !ALLOWED_SYSTEM_SYMLINKS.has(current)) throw new Error(`Benchmark root contains a symlink component: ${current}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Benchmark root contains a symlink component:")) throw error;
      break;
    }
  }
}

const ALLOWED_SYSTEM_SYMLINKS = new Set(["/var", "/tmp"]);

export function prepareArmRoots(arm: { agent?: "butler" | "hermes" | "opencode"; dataRoot: string; evidenceRoot: string; outputRoot: string; cacheRoot: string; cache: "cold" | "warm"; key: string }): void {
  if (arm.cache === "cold") rmSync(arm.cacheRoot, { recursive: true, force: true });
  mkdirSync(arm.cacheRoot, { recursive: true });
  mkdirSync(arm.dataRoot, { recursive: true });
  // The BTCC Electron harness owns its runRoot lifecycle and requires the
  // path not to exist when it is invoked. External adapters create usage
  // evidence just-in-time, so they retain the eager evidence directory.
  if (arm.agent !== "butler") mkdirSync(arm.evidenceRoot, { recursive: true });
  mkdirSync(arm.outputRoot, { recursive: true });
  if (readdirSync(arm.outputRoot).length > 0) throw new Error(`Output workspace is not empty: ${arm.key}`);
}

export function sourceIntegrity(root: string): { commit: string | null; status: string | null } {
  try {
    const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const status = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { commit, status };
  } catch {
    return { commit: null, status: null };
  }
}

export function benchmarkPlatformGate(): string | null {
  return process.platform === "win32"
    ? "Benchmark process-group isolation is supported only on macOS/Linux; Windows is configuration_unverifiable."
    : null;
}

export function sameIntegrity(
  before: { commit: string | null; status: string | null },
  after: { commit: string | null; status: string | null },
): boolean {
  return before.commit === after.commit && before.status === after.status;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}
