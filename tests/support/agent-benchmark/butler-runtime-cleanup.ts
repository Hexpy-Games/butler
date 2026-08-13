import { lstatSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BenchmarkArmPlan } from "./contracts.ts";
import {
  decideAbsentButlerRuntimeExport,
  decideButlerRuntimeExport,
  type ButlerDurableExportState,
} from "./butler-runtime-export-decision.ts";
import {
  hasButlerRuntimeSymlinkComponent,
  hasUnsafeButlerRuntimeDirectoryComponent,
  isStrictlyInsideButlerRuntime,
} from "./butler-runtime-path-safety.ts";

const MAX_HARNESS_EVIDENCE_BYTES = 1 * 1024 * 1024;
const CLEANUP_FAILURE_DIAGNOSTIC = "Butler runtime cleanup could not be verified.";

export type ButlerRuntimeCleanupStatus = "removed" | "absent" | "unsafe" | "failed";

export interface ButlerRuntimeCleanupResult {
  status: ButlerRuntimeCleanupStatus;
  diagnostic: string | null;
  reason: ButlerRuntimeCleanupReason | null;
}

export type ButlerRuntimeCleanupReason =
  | "durable_export_required"
  | "runtime_observation_ambiguous"
  | "runtime_removal_failed"
  | "runtime_root_unsafe";

/** Reads only the bounded structured evidence written by the Electron harness. */
export function readButlerHarnessEvidence(evidenceRoot: string): Record<string, unknown> | null {
  const root = resolve(evidenceRoot);
  const evidencePath = join(root, "evidence.json");
  if (hasButlerRuntimeSymlinkComponent(root) || hasButlerRuntimeSymlinkComponent(evidencePath)) return null;
  try {
    const stat = lstatSync(evidencePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_HARNESS_EVIDENCE_BYTES) return null;
    const value: unknown = JSON.parse(readFileSync(evidencePath, "utf8"));
    return asRecord(value);
  } catch {
    return null;
  }
}

/** Raw Electron evidence is transient input, never retained campaign evidence. */
export function removeRawButlerHarnessEvidence(evidenceRoot: string): boolean {
  const root = resolve(evidenceRoot); const evidencePath = join(root, "evidence.json");
  if (hasUnsafeButlerRuntimeDirectoryComponent(root)) return false;
  try {
    const stat = lstatSync(evidencePath);
    if (hasButlerRuntimeSymlinkComponent(evidencePath)) return false;
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    unlinkSync(evidencePath); return true;
  } catch (error) { return isMissingPath(error); }
}

/** Removes every non-typed arm artifact after extraction, including failure logs and workspaces. */
export function prunePrivateButlerEvidenceCorpus(
  evidenceRoot: string,
  verifiedTypedFiles: ReadonlySet<string>,
): boolean {
  const root = resolve(evidenceRoot);
  if (hasUnsafeButlerRuntimeDirectoryComponent(root)) return false;
  try {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (verifiedTypedFiles.has(entry.name) && entry.isFile() && !entry.isSymbolicLink()) continue;
      rmSync(join(root, entry.name), { recursive: true, force: true });
    }
    return true;
  } catch (error) { return isMissingPath(error); }
}

/**
 * Removes only the BTCC runtime data directory after telemetry/artifacts have
 * been extracted. Any ambiguous, out-of-root, or symlinked target is left in
 * place rather than risking evidence, output, cache, or source deletion.
 */
export function cleanupButlerRuntime(
  evidence: Record<string, unknown>,
  arm: Pick<BenchmarkArmPlan, "evidenceRoot" | "outputRoot" | "cacheRoot" | "dataRoot" | "sourceRoot">,
  durableExport: ButlerDurableExportState,
): ButlerRuntimeCleanupResult {
  const run = asRecord(evidence.run);
  const dataRoot = typeof run?.dataRoot === "string" ? run.dataRoot.trim() : "";
  if (!dataRoot) return absentCleanupResult(durableExport);
  const evidenceRoot = resolve(arm.evidenceRoot);
  const target = resolve(dataRoot);
  if (!isStrictlyInsideButlerRuntime(evidenceRoot, target)) return cleanupResult("unsafe");
  const protectedRoots = [arm.outputRoot, arm.cacheRoot, arm.dataRoot, arm.sourceRoot].map((path) => resolve(path));
  if (protectedRoots.some((protectedRoot) => target === protectedRoot || isStrictlyInsideButlerRuntime(target, protectedRoot) || isStrictlyInsideButlerRuntime(protectedRoot, target))) {
    return cleanupResult("unsafe");
  }
  let targetStat;
  try {
    targetStat = lstatSync(target);
  } catch (error) {
    return isMissingPath(error)
      ? absentCleanupResult(durableExport)
      : cleanupResult("failed", "runtime_observation_ambiguous");
  }
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory() || hasButlerRuntimeSymlinkComponent(target)) {
    return cleanupResult("unsafe");
  }
  try {
    const evidenceReal = realpathSync(evidenceRoot);
    const targetReal = realpathSync(target);
    if (!isStrictlyInsideButlerRuntime(evidenceReal, targetReal) || targetReal === evidenceReal) return cleanupResult("unsafe");
    const stat = statSync(target);
    if (!stat.isDirectory()) return cleanupResult("unsafe");
    const decision = decideButlerRuntimeExport({ evidence, durableExport });
    if (!decision.cleanupAllowed) {
      return cleanupResult("failed", decision.reason);
    }
    rmSync(target, { recursive: true, force: false });
    return cleanupResult("removed");
  } catch {
    return cleanupResult("failed", "runtime_removal_failed");
  }
}

function absentCleanupResult(durableExport: ButlerDurableExportState): ButlerRuntimeCleanupResult {
  const decision = decideAbsentButlerRuntimeExport(durableExport);
  return decision.cleanupAllowed
    ? cleanupResult("absent")
    : cleanupResult("failed", decision.reason);
}

function isMissingPath(error: unknown): boolean {
  return Boolean(error && typeof error === "object" &&
    (error as { code?: unknown }).code === "ENOENT");
}

function cleanupResult(
  status: ButlerRuntimeCleanupStatus,
  reason: ButlerRuntimeCleanupReason | null = status === "unsafe" ? "runtime_root_unsafe" : null,
): ButlerRuntimeCleanupResult {
  return {
    status,
    diagnostic: status === "unsafe" || status === "failed" ? CLEANUP_FAILURE_DIAGNOSTIC : null,
    reason,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
