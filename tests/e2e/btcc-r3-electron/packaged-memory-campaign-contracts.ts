import type { ElectronHarnessOptions } from "./contracts.ts";
import {
  PACKAGED_MEMORY_CACHE_POLICY,
  portableCommandLabel,
  portableExecutableLabel,
  summarizeRolePhysicalMemorySeries,
  type CampaignRolePhysicalMemorySeries,
  type PackagedMemoryGuardEvidence,
} from "./packaged-memory-campaign-evidence.ts";
import type { BunRuntimeEvidence } from "../../support/bun-runtime-ab.ts";
import type {
  EmbedIdleReclamation,
  PhysicalMemoryGateResult,
} from "../../support/physical-memory-gate.ts";
import type {
  PackagedPerformanceSnapshot,
  PackagedProcessTarget,
} from "../../support/packaged-performance-snapshot.ts";

export const PACKAGED_MEMORY_CAMPAIGN_SCHEMA =
  "butler.packaged-memory-campaign.v1" as const;

export interface PackagedMemoryCampaignOptions extends ElectronHarnessOptions {
  runtimeVariant?: "pinned" | "candidate";
  warmupCycles?: number;
  steadyCycles?: number;
  historyMessages?: number;
  idleWaitMs?: number;
  archiveStreamEvidence?: PackagedMemoryGuardEvidence;
  packagingEvidence?: PackagedMemoryGuardEvidence;
}

export interface PackagedMemoryCampaignResult {
  schema: typeof PACKAGED_MEMORY_CAMPAIGN_SCHEMA;
  ok: boolean;
  variant: "pinned" | "candidate";
  runtime: {
    executableName: string;
    executableFingerprint?: string;
    bunVersion: string;
    managedExecutableName: string;
    managedExecutableFingerprint?: string;
    managedBunVersion: string;
    bundledExecutableName: string;
    bundledExecutableFingerprint?: string;
    bundledBunVersion: string;
  };
  sourceFingerprint: string;
  dataFingerprint: string;
  cacheFingerprint: string;
  cachePolicy: typeof PACKAGED_MEMORY_CACHE_POLICY;
  cacheResourceDigest: string;
  modelCacheDigest: string;
  warmupCycles: number;
  steadyCycles: number;
  processTargets: PackagedProcessTarget[];
  cycles: PackagedPerformanceSnapshot[];
  /** Stable role/label diagnostics without PIDs or command lines. */
  rolePhysicalMemorySeries?: CampaignRolePhysicalMemorySeries[];
  idle: PackagedPerformanceSnapshot | null;
  idleReclamation: EmbedIdleReclamation | null;
  physicalGate: PhysicalMemoryGateResult;
  correctness: { ok: boolean; checks: string[] };
  archiveStream: PackagedMemoryGuardEvidence;
  packaging: PackagedMemoryGuardEvidence;
  providerTerminalStates: string[];
  error?: CampaignErrorEvidence;
}

/**
 * Campaign failures are intentionally a closed, privacy-safe vocabulary. The
 * campaign may run against a private worktree and local provider data, so raw
 * exception messages and paths must never become evidence fields.
 */
export const CAMPAIGN_ERROR_CODES = [
  "campaign_prepare_failed",
  "campaign_seed_failed",
  "campaign_runtime_identity_failed",
  "campaign_process_attribution_failed",
  "campaign_provider_terminal_failed",
  "campaign_public_read_failed",
  "campaign_idle_failed",
  "campaign_fingerprint_failed",
  "campaign_cache_digest_unavailable",
  "campaign_guard_evidence_invalid",
  "campaign_unknown",
] as const;

export type CampaignErrorCode = (typeof CAMPAIGN_ERROR_CODES)[number];

export interface CampaignErrorEvidence {
  code: CampaignErrorCode;
  detail: string;
}

export class CampaignFailure extends Error {
  readonly code: CampaignErrorCode;
  readonly detail: string;

  constructor(code: CampaignErrorCode, detail: string) {
    super("Packaged memory campaign failed.");
    this.name = "CampaignFailure";
    this.code = code;
    this.detail = detail;
  }
}

export function normalizeCampaignError(
  error: unknown,
  fallback: CampaignErrorCode = "campaign_unknown",
): CampaignErrorEvidence {
  if (error instanceof CampaignFailure) {
    return { code: error.code, detail: error.detail };
  }
  return { code: fallback, detail: "campaign step failed" };
}

export const REQUIRED_CAMPAIGN_CHECKS = [
  "provider-terminal",
  "large-history-window",
  "delta-refresh",
  "cursor-resync",
  "before-cursor-page",
  "transcript-export",
  "usage-health",
  "sse-reconnect",
  "owned-sidecar-lifecycle",
] as const;

export function evaluateCampaignCorrectness(
  checks: readonly string[],
  terminalStates: readonly string[],
): boolean {
  const observedChecks = new Set(checks);
  return REQUIRED_CAMPAIGN_CHECKS.every((check) => observedChecks.has(check)) &&
    terminalStates.length > 0 &&
    terminalStates.every((state) => state !== "failed" && state !== "unknown");
}

export function campaignAsBunRuntimeEvidence(
  result: PackagedMemoryCampaignResult,
): BunRuntimeEvidence {
  return {
    variant: result.variant,
    executable: result.runtime.executableName,
    ...(result.runtime.executableFingerprint
      ? { executableFingerprint: result.runtime.executableFingerprint }
      : {}),
    version: result.runtime.bunVersion,
    managedExecutable: result.runtime.managedExecutableName,
    ...(result.runtime.managedExecutableFingerprint
      ? { managedExecutableFingerprint: result.runtime.managedExecutableFingerprint }
      : {}),
    managedVersion: result.runtime.managedBunVersion,
    bundledExecutable: result.runtime.bundledExecutableName,
    ...(result.runtime.bundledExecutableFingerprint
      ? { bundledExecutableFingerprint: result.runtime.bundledExecutableFingerprint }
      : {}),
    bundledVersion: result.runtime.bundledBunVersion,
    sourceFingerprint: result.sourceFingerprint,
    dataFingerprint: result.dataFingerprint,
    warmupCycles: result.warmupCycles,
    steadyCycles: result.steadyCycles,
    processTargets: result.processTargets,
    rolePhysicalMemorySeries: result.rolePhysicalMemorySeries ?? summarizeRolePhysicalMemorySeries(result.cycles),
    cacheFingerprint: result.cacheFingerprint,
    cachePolicy: result.cachePolicy,
    cacheResourceDigest: result.cacheResourceDigest,
    modelCacheDigest: result.modelCacheDigest,
    physicalGate: result.physicalGate,
    correctness: { ok: result.correctness.ok, detail: result.correctness.checks.join(",") },
    archiveStream: guardEvidenceToCheck(result.archiveStream),
    packaging: guardEvidenceToCheck(result.packaging),
    ...(result.error ? { error: result.error } : {}),
  };
}

function guardEvidenceToCheck(evidence: PackagedMemoryGuardEvidence) {
  return {
    ok: evidence.ok,
    detail: evidence.reason,
    attempts: evidence.attempts,
    successes: evidence.successes,
    ...(evidence.schema ? { schema: evidence.schema } : {}),
    ...(evidence.executableLabel
      ? { executable: portableExecutableLabel(evidence.executableLabel) }
      : {}),
    ...(evidence.executableFingerprint
      ? { executableFingerprint: evidence.executableFingerprint }
      : {}),
    ...(evidence.bunVersion ? { version: evidence.bunVersion } : {}),
    ...(evidence.commandLabel
      ? { commandLabel: portableCommandLabel(evidence.commandLabel) }
      : {}),
    ...(evidence.commandFingerprint
      ? { commandFingerprint: evidence.commandFingerprint }
      : {}),
  };
}
