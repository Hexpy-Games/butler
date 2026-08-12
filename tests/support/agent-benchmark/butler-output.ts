import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { AdapterRunResult, BenchmarkArmPlan, BenchmarkFixture } from "./contracts.ts";
import { inventoryOutputFiles } from "./repository-evidence.ts";

export function copyGeneratedArtifacts(
  evidence: Record<string, unknown>,
  input: { arm: BenchmarkArmPlan; fixture: Pick<BenchmarkFixture, "id" | "expectedFiles" | "m1V2"> },
): void {
  if (!isArtifactProducingLandingFixture(input.fixture)) return;
  const run = asRecord(evidence.run);
  const workspaceRoot = typeof run?.workspaceRoot === "string" ? run.workspaceRoot : null;
  if (!workspaceRoot) return;
  const generatedFiles = inventoryOutputFiles(workspaceRoot).filter((path) => !isExcludedWorkspacePath(path));
  for (const path of generatedFiles) {
    const source = resolve(workspaceRoot, path);
    const destination = resolve(input.arm.outputRoot, path);
    const relativePath = relative(resolve(input.arm.outputRoot), destination);
    if (relativePath === ".." || relativePath.startsWith("../") || relativePath.includes("\0")) continue;
    if (!existsSync(source) || !lstatSync(source).isFile()) continue;
    mkdirSync(resolve(destination, ".."), { recursive: true });
    copyFileSync(source, destination);
  }
}

function isArtifactProducingLandingFixture(
  fixture: Pick<BenchmarkFixture, "id" | "m1V2">,
): boolean {
  return fixture.id === "butler_landing_page" || fixture.m1V2?.armId === "landing-cold";
}

function isExcludedWorkspacePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return normalized === ".benchmark-input" || normalized.startsWith(".benchmark-input/") ||
    normalized === ".git" || normalized.startsWith(".git/") ||
    normalized === "node_modules" || normalized.startsWith("node_modules/") ||
    normalized === "dist" || normalized.startsWith("dist/") ||
    normalized === "build" || normalized.startsWith("build/") ||
    normalized === "coverage" || normalized.startsWith("coverage/") ||
    normalized === ".cache" || normalized.startsWith(".cache/") ||
    normalized === ".next" || normalized.startsWith(".next/") ||
    normalized === "out" || normalized.startsWith("out/");
}

export function gatedAdapterResult(
  gateCode: AdapterRunResult["gateCode"],
  diagnostic: string,
  adapterVersion: string | null = "butler-local",
): AdapterRunResult {
  return {
    exitCode: null,
    gateCode,
    timedOut: false,
    cancelled: false,
    stdout: "",
    stderr: diagnostic,
    adapterVersion,
    provider: null,
    finalText: null,
    sessionId: null,
    usage: {},
    tools: { calls: null, failedCalls: null, records: [] },
    timing: {},
    operations: {},
    changedPaths: [],
    evidenceRefs: [],
  };
}

export function readButlerVersion(path: string): string | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof asRecord(value)?.version === "string" ? String(asRecord(value)?.version) : null;
  } catch {
    return null;
  }
}

export function sumNullable(values: readonly (number | null)[]): number | null {
  if (values.length === 0 || values.some((value) => value === null)) return null;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

export function boundedUsefulTime(value: number | null, submittedAtMs: number, terminalAtMs: number): number | null {
  return typeof value === "number" && value >= submittedAtMs && value <= terminalAtMs ? value : null;
}

export function rootsOverlap(left: string, right: string): boolean {
  const leftRoot = resolve(left);
  const rightRoot = resolve(right);
  return insideRoot(relative(leftRoot, rightRoot)) || insideRoot(relative(rightRoot, leftRoot));
}

function insideRoot(path: string): boolean {
  return path === "" || (path !== ".." && !path.startsWith("../") && !isAbsolute(path));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
