import { lstatSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { BenchmarkArmPlan } from "./contracts.ts";

const MAX_HARNESS_EVIDENCE_BYTES = 1 * 1024 * 1024;
const ALLOWED_SYSTEM_SYMLINKS = new Set(["/var", "/tmp"]);
const CLEANUP_FAILURE_DIAGNOSTIC = "Butler runtime cleanup could not be verified.";

export type ButlerRuntimeCleanupStatus = "removed" | "absent" | "unsafe" | "failed";

export interface ButlerRuntimeCleanupResult {
  status: ButlerRuntimeCleanupStatus;
  diagnostic: string | null;
}

/** Reads only the bounded structured evidence written by the Electron harness. */
export function readButlerHarnessEvidence(evidenceRoot: string): Record<string, unknown> | null {
  const root = resolve(evidenceRoot);
  const evidencePath = join(root, "evidence.json");
  if (hasSymlinkComponent(root) || hasSymlinkComponent(evidencePath)) return null;
  try {
    const stat = lstatSync(evidencePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_HARNESS_EVIDENCE_BYTES) return null;
    const value: unknown = JSON.parse(readFileSync(evidencePath, "utf8"));
    return asRecord(value);
  } catch {
    return null;
  }
}

/**
 * Removes only the BTCC runtime data directory after telemetry/artifacts have
 * been extracted. Any ambiguous, out-of-root, or symlinked target is left in
 * place rather than risking evidence, output, cache, or source deletion.
 */
export function cleanupButlerRuntime(
  evidence: Record<string, unknown>,
  arm: Pick<BenchmarkArmPlan, "evidenceRoot" | "outputRoot" | "cacheRoot" | "dataRoot" | "sourceRoot">,
): ButlerRuntimeCleanupResult {
  const run = asRecord(evidence.run);
  const dataRoot = typeof run?.dataRoot === "string" ? run.dataRoot.trim() : "";
  if (!dataRoot) return cleanupResult("absent");
  const evidenceRoot = resolve(arm.evidenceRoot);
  const target = resolve(dataRoot);
  let targetStat;
  try {
    targetStat = lstatSync(target);
  } catch {
    return cleanupResult("absent");
  }
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory() || !strictlyInside(evidenceRoot, target) || hasSymlinkComponent(target)) {
    return cleanupResult("unsafe");
  }
  const protectedRoots = [arm.outputRoot, arm.cacheRoot, arm.dataRoot, arm.sourceRoot].map((path) => resolve(path));
  if (protectedRoots.some((protectedRoot) => target === protectedRoot || strictlyInside(target, protectedRoot) || strictlyInside(protectedRoot, target))) {
    return cleanupResult("unsafe");
  }
  try {
    const evidenceReal = realpathSync(evidenceRoot);
    const targetReal = realpathSync(target);
    if (!strictlyInside(evidenceReal, targetReal) || targetReal === evidenceReal) return cleanupResult("unsafe");
    const stat = statSync(target);
    if (!stat.isDirectory()) return cleanupResult("unsafe");
    rmSync(target, { recursive: true, force: false });
    return cleanupResult("removed");
  } catch {
    return cleanupResult("failed");
  }
}

function hasSymlinkComponent(path: string): boolean {
  const resolved = resolve(path);
  const parsed = parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink() && !ALLOWED_SYSTEM_SYMLINKS.has(current)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function cleanupResult(status: ButlerRuntimeCleanupStatus): ButlerRuntimeCleanupResult {
  return { status, diagnostic: status === "unsafe" || status === "failed" ? CLEANUP_FAILURE_DIAGNOSTIC : null };
}

function strictlyInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && !rel.includes("\0");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
