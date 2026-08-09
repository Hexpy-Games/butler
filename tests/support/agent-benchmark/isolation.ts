import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { BenchmarkPlan } from "./contracts.ts";
import { AGENT_BENCHMARK_BASELINE_SHA, AGENT_BENCHMARK_SCHEMA } from "./contracts.ts";

export function validateBenchmarkPlan(plan: BenchmarkPlan): void {
  if (plan.schema !== AGENT_BENCHMARK_SCHEMA || plan.kind !== "agent_benchmark_plan") throw new Error("Agent benchmark plan schema mismatch");
  if (plan.baselineSha !== AGENT_BENCHMARK_BASELINE_SHA) throw new Error(`Agent benchmark baseline mismatch: ${plan.baselineSha}`);
  if (!Number.isSafeInteger(plan.seed)) throw new Error("Agent benchmark seed is required");
  const runRoot = resolve(plan.runRoot);
  const sourceRoot = resolve(plan.sourceRoot);
  assertNoSymlinkComponents(runRoot);
  assertNoSymlinkComponents(sourceRoot);
  if (runRoot === sourceRoot || inside(sourceRoot, runRoot) || inside(runRoot, sourceRoot)) throw new Error("Benchmark run root and source root must be isolated");
  const fixtureHashes = new Map(plan.fixtures.map((fixture) => [fixture.id, fixture.sha256]));
  for (const arm of plan.arms) {
    if (arm.fixtureHash !== fixtureHashes.get(arm.scenario)) throw new Error(`Fixture hash mismatch for arm ${arm.key}`);
    for (const path of [arm.outputRoot, arm.dataRoot, arm.evidenceRoot, arm.cacheRoot]) {
      if (!inside(runRoot, resolve(path))) throw new Error(`Arm path escapes run root: ${path}`);
    }
    if (resolve(arm.sourceRoot) !== sourceRoot) throw new Error(`Arm source root mismatch: ${arm.key}`);
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
