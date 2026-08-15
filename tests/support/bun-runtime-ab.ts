import type { PackagedProcessTarget } from "./packaged-performance-snapshot.ts";
import type { PhysicalMemoryGateResult } from "./physical-memory-gate.ts";
import type { CampaignRolePhysicalMemorySeries } from "../e2e/btcc-r3-electron/packaged-memory-campaign-evidence.ts";

export const BUN_RUNTIME_AB_SCHEMA = "butler.bun-runtime-ab.v1" as const;
export const PINNED_BUN_VERSION = "1.3.11" as const;
export const CANDIDATE_BUN_VERSION = "1.3.14" as const;
export const ARCHIVE_STREAM_GUARD_ATTEMPTS = 10;
/** A 5% relative margin keeps allocator noise from authorizing a pin change. */
export const MIN_PHYSICAL_IMPROVEMENT_RATIO = 0.05;

export type BunRuntimeVariant = "pinned" | "candidate";
export type BunRuntimeAbDecision = "candidate" | "no-change";

export interface BunRuntimeAbManifest {
  schema: typeof BUN_RUNTIME_AB_SCHEMA;
  sourceFingerprint: string;
  dataFingerprint: string;
  warmupCycles: number;
  steadyCycles: number;
  pinned: BunRuntimeEvidence;
  candidate: BunRuntimeEvidence;
}

export interface BunRuntimeEvidence {
  variant: BunRuntimeVariant;
  /** Bounded executable labels; absolute paths are never portable evidence. */
  executable: string;
  executableFingerprint?: string;
  version: string;
  managedExecutable?: string;
  managedExecutableFingerprint?: string;
  managedVersion?: string;
  bundledExecutable?: string;
  bundledExecutableFingerprint?: string;
  bundledVersion?: string;
  sourceFingerprint: string;
  dataFingerprint: string;
  warmupCycles: number;
  steadyCycles: number;
  /** Process roles/labels are compared; PIDs are expected to differ per run. */
  processTargets: PackagedProcessTarget[];
  /** Stable role/label physical series; PIDs and commands stay local. */
  rolePhysicalMemorySeries?: CampaignRolePhysicalMemorySeries[];
  /** A stable fixture/cache identity. Mismatched values are descriptive only. */
  cacheFingerprint?: string;
  /** Explicit cache policy/resource identity used for A/B comparability. */
  cachePolicy?: string;
  cacheResourceDigest?: string;
  modelCacheDigest?: string;
  physicalGate: PhysicalMemoryGateResult;
  correctness: BunRuntimeCheck;
  archiveStream: BunRuntimeCheck;
  packaging: BunRuntimeCheck;
  /** Privacy-safe campaign failure context retained for failed runs. */
  error?: {
    code: string;
    detail: string;
  };
}

export interface BunRuntimeCheck {
  ok: boolean;
  schema?: string;
  detail?: string;
  /** Bounded command shape; raw arguments remain local-only. */
  commandLabel?: string;
  commandFingerprint?: string;
  attempts?: number;
  successes?: number;
  /** Bounded executable basename captured by command-derived guards. */
  executable?: string;
  /** Stable hash of the local executable path. */
  executableFingerprint?: string;
  version?: string;
}

export interface BunRuntimeAbReport {
  schema: typeof BUN_RUNTIME_AB_SCHEMA;
  expectedVersions: {
    pinned: typeof PINNED_BUN_VERSION;
    candidate: typeof CANDIDATE_BUN_VERSION;
  };
  comparable: boolean;
  decision: BunRuntimeAbDecision;
  recommendation: "keep-pinned" | "adopt-candidate";
  reasons: string[];
  comparability: {
    sourceMatch: boolean;
    dataMatch: boolean;
    cyclesMatch: boolean;
    processAttributionMatch: boolean;
    cacheMatch: boolean;
  };
  variants: Record<BunRuntimeVariant, BunRuntimeSummary>;
}

export interface BunRuntimeSummary {
  version: string;
  eligible: boolean;
  /**
   * A pinned run may carry a historical Electron-parent archive diagnostic
   * failure. It can still provide a physical baseline, while a candidate run
   * must remain fully eligible (including its archive guard) before adoption.
   */
  baselineEligible: boolean;
  eligibilityReasons: string[];
  baselineEligibilityReasons: string[];
  physicalGate: PhysicalMemoryGateResult;
  memoryRatio: number | null;
  resourceRatio: number | null;
}

export function createBunRuntimeAbManifest(
  pinned: BunRuntimeEvidence,
  candidate: BunRuntimeEvidence,
): BunRuntimeAbManifest {
  if (pinned.variant !== "pinned" || candidate.variant !== "candidate") {
    throw new Error("Bun A/B manifest requires pinned and candidate evidence in matching slots");
  }
  if (pinned.sourceFingerprint !== candidate.sourceFingerprint ||
    pinned.dataFingerprint !== candidate.dataFingerprint ||
    pinned.warmupCycles !== candidate.warmupCycles ||
    pinned.steadyCycles !== candidate.steadyCycles) {
    throw new Error("Bun A/B manifest requires matching source/data/cycle evidence");
  }
  return {
    schema: BUN_RUNTIME_AB_SCHEMA,
    sourceFingerprint: pinned.sourceFingerprint,
    dataFingerprint: pinned.dataFingerprint,
    warmupCycles: pinned.warmupCycles,
    steadyCycles: pinned.steadyCycles,
    pinned,
    candidate,
  };
}

export function compareBunRuntimeAb(input: BunRuntimeAbManifest): BunRuntimeAbReport {
  const pinned = input.pinned;
  const candidate = input.candidate;
  const sourceMatch = input.sourceFingerprint === pinned.sourceFingerprint &&
    input.sourceFingerprint === candidate.sourceFingerprint;
  const dataMatch = input.dataFingerprint === pinned.dataFingerprint &&
    input.dataFingerprint === candidate.dataFingerprint;
  const cyclesMatch = input.warmupCycles === pinned.warmupCycles &&
    input.warmupCycles === candidate.warmupCycles &&
    input.steadyCycles === pinned.steadyCycles &&
    input.steadyCycles === candidate.steadyCycles;
  const processAttributionMatch = sameProcessAttribution(
    pinned.processTargets,
    candidate.processTargets,
  );
  const cacheMatch = pinned.cacheFingerprint !== undefined &&
    pinned.cacheFingerprint === candidate.cacheFingerprint &&
    pinned.cachePolicy !== undefined &&
    pinned.cachePolicy === candidate.cachePolicy &&
    pinned.cacheResourceDigest !== undefined &&
    pinned.cacheResourceDigest === candidate.cacheResourceDigest &&
    pinned.modelCacheDigest !== undefined &&
    pinned.modelCacheDigest === candidate.modelCacheDigest;
  const comparability = {
    sourceMatch,
    dataMatch,
    cyclesMatch,
    processAttributionMatch,
    cacheMatch,
  };
  const reasons: string[] = [];
  if (input.schema !== BUN_RUNTIME_AB_SCHEMA) {
    reasons.push(`manifest schema is not ${BUN_RUNTIME_AB_SCHEMA}`);
  }
  if (!sourceMatch) reasons.push("source fixture fingerprints differ");
  if (!dataMatch) reasons.push("data fixture fingerprints differ");
  if (!cyclesMatch) reasons.push("warm-up or steady-state cycle counts differ");
  if (!processAttributionMatch) reasons.push("process role attribution differs");
  if (!cacheMatch) reasons.push("cache fingerprints are missing or differ; samples are descriptive only");

  const pinnedSummary = summarizeEvidence(pinned);
  const candidateSummary = summarizeEvidence(candidate);
  reasons.push(...pinnedSummary.eligibilityReasons.map((reason) => `pinned: ${reason}`));
  reasons.push(...candidateSummary.eligibilityReasons.map((reason) => `candidate: ${reason}`));

  const comparable = input.schema === BUN_RUNTIME_AB_SCHEMA && Object.values(comparability).every(Boolean);
  const candidateImproves = hasPhysicalImprovement(pinnedSummary, candidateSummary);
  if (comparable && candidateSummary.eligible && candidateImproves) {
    reasons.push("candidate improves the gated physical metric without a safety regression");
    return {
      schema: BUN_RUNTIME_AB_SCHEMA,
      expectedVersions: { pinned: PINNED_BUN_VERSION, candidate: CANDIDATE_BUN_VERSION },
      comparable,
      decision: "candidate",
      recommendation: "adopt-candidate",
      reasons,
      comparability,
      variants: { pinned: pinnedSummary, candidate: candidateSummary },
    };
  }
  if (!candidateSummary.eligible) {
    reasons.push("candidate is not eligible for a runtime change");
  } else if (!comparable) {
    reasons.push("A/B evidence is not comparable; retain the repository pin");
  } else if (!candidateImproves) {
    reasons.push("candidate does not improve every gated physical comparison");
  }
  return {
    schema: BUN_RUNTIME_AB_SCHEMA,
    expectedVersions: { pinned: PINNED_BUN_VERSION, candidate: CANDIDATE_BUN_VERSION },
    comparable,
    decision: "no-change",
    recommendation: "keep-pinned",
    reasons,
    comparability,
    variants: { pinned: pinnedSummary, candidate: candidateSummary },
  };
}

function summarizeEvidence(evidence: BunRuntimeEvidence): BunRuntimeSummary {
  const eligibilityReasons: string[] = [];
  const baselineEligibilityReasons: string[] = [];
  if (evidence.error) {
    eligibilityReasons.push(`campaign failed: ${evidence.error.code}`);
    baselineEligibilityReasons.push(`campaign failed: ${evidence.error.code}`);
  }
  const expectedVariant = evidence.variant;
  if (expectedVariant !== "pinned" && expectedVariant !== "candidate") {
    eligibilityReasons.push("runtime variant is invalid");
    baselineEligibilityReasons.push("runtime variant is invalid");
  }
  const expectedVersion = evidence.variant === "pinned"
    ? PINNED_BUN_VERSION
    : CANDIDATE_BUN_VERSION;
  if (evidence.version !== expectedVersion) {
    eligibilityReasons.push(`expected Bun ${expectedVersion}, observed ${evidence.version || "unknown"}`);
    baselineEligibilityReasons.push(`expected Bun ${expectedVersion}, observed ${evidence.version || "unknown"}`);
  }
  if (!evidence.physicalGate.ok) {
    eligibilityReasons.push("physical memory gate failed");
    baselineEligibilityReasons.push("physical memory gate failed");
  }
  for (const [name, check] of [
    ["correctness", evidence.correctness],
    ["Electron-parent archive stream", evidence.archiveStream],
    ["packaging", evidence.packaging],
  ] as const) {
    if (!check.ok) {
      eligibilityReasons.push(`${name} check failed${check.detail ? `: ${check.detail}` : ""}`);
      // Archive regressions are preserved as diagnostics for the pinned
      // baseline. They remain a hard failure for candidate eligibility.
      if (name !== "Electron-parent archive stream") {
        baselineEligibilityReasons.push(`${name} check failed${check.detail ? `: ${check.detail}` : ""}`);
      }
    }
    if (name !== "correctness") {
      const expectedAttempts = name === "Electron-parent archive stream" ? ARCHIVE_STREAM_GUARD_ATTEMPTS : 23;
      const expectedSchema = name === "Electron-parent archive stream"
        ? "butler.archive-stream-guard.v1"
        : "butler.bun-packaging-guard.v1";
      if (check.schema !== expectedSchema) {
        eligibilityReasons.push(`${name} evidence schema is missing or invalid`);
        baselineEligibilityReasons.push(`${name} evidence schema is missing or invalid`);
      }
      if (check.version !== expectedVersion) {
        eligibilityReasons.push(`${name} evidence used ${check.version || "unknown"}, expected Bun ${expectedVersion}`);
        baselineEligibilityReasons.push(`${name} evidence used ${check.version || "unknown"}, expected Bun ${expectedVersion}`);
      }
      if (check.executable === undefined || check.executable.trim() === "") {
        eligibilityReasons.push(`${name} evidence is missing executable identity`);
        baselineEligibilityReasons.push(`${name} evidence is missing executable identity`);
      }
      if (check.executableFingerprint === undefined || check.executableFingerprint.trim() === "") {
        eligibilityReasons.push(`${name} evidence is missing executable fingerprint`);
        baselineEligibilityReasons.push(`${name} evidence is missing executable fingerprint`);
      }
      if (check.commandLabel === undefined || check.commandLabel.trim() === "" ||
        check.commandFingerprint === undefined || check.commandFingerprint.trim() === "") {
        eligibilityReasons.push(`${name} evidence is missing portable command identity`);
        baselineEligibilityReasons.push(`${name} evidence is missing portable command identity`);
      }
      const archiveDiagnostic = name === "Electron-parent archive stream";
      if (check.attempts !== expectedAttempts || check.successes !== check.attempts) {
        eligibilityReasons.push(
          `${name} lacks ${expectedAttempts}/${expectedAttempts} execution evidence`,
        );
        if (!archiveDiagnostic || check.attempts !== expectedAttempts) {
          baselineEligibilityReasons.push(
            `${name} lacks ${expectedAttempts}/${expectedAttempts} execution evidence`,
          );
        }
      }
    }
  }
  return {
    version: evidence.version,
    eligible: eligibilityReasons.length === 0,
    baselineEligible: baselineEligibilityReasons.length === 0,
    eligibilityReasons,
    baselineEligibilityReasons,
    physicalGate: evidence.physicalGate,
    memoryRatio: finiteMetric(evidence.physicalGate.metrics.finalVsFirstRatio),
    resourceRatio: ratioFromSeries(evidence.physicalGate.metrics.resourceValues),
  };
}

function hasPhysicalImprovement(
  pinned: BunRuntimeSummary,
  candidate: BunRuntimeSummary,
): boolean {
  if (!candidate.eligible) return false;
  if (!pinned.baselineEligible || pinned.memoryRatio === null || candidate.memoryRatio === null) return false;
  if (pinned.resourceRatio === null || candidate.resourceRatio === null) return false;
  const relativeImprovement = (pinned.memoryRatio - candidate.memoryRatio) / pinned.memoryRatio;
  const memoryImproved = relativeImprovement >= MIN_PHYSICAL_IMPROVEMENT_RATIO;
  const resourcesImproved = candidate.resourceRatio <= pinned.resourceRatio;
  return memoryImproved && resourcesImproved;
}

function sameProcessAttribution(
  pinned: PackagedProcessTarget[],
  candidate: PackagedProcessTarget[],
): boolean {
  const normalize = (targets: PackagedProcessTarget[]) => targets
    .map((target) => `${target.role}:${target.label ?? ""}`)
    .sort();
  return JSON.stringify(normalize(pinned)) === JSON.stringify(normalize(candidate));
}

function ratioFromSeries(values: Array<number | null>): number | null {
  const numeric = values.filter((value): value is number => Number.isFinite(value));
  if (numeric.length < 2) return null;
  const first = median(numeric.slice(0, 3));
  const last = median(numeric.slice(-3));
  return first > 0 ? last / first : null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function finiteMetric(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
