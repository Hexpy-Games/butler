import { statfsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";

const MAX_BUNDLED_AGENT_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const CONCURRENT_ARCHIVE_CEILINGS = 4;
const RUN_METADATA_RESERVE_BYTES = 512 * 1024 * 1024;

/**
 * The packaging output, harness resource copy, App staging payload copy, and
 * extracted runtime can coexist until product activation completes.
 */
const BUNDLED_AGENT_PREPARATION_REQUIRED_BYTES =
  MAX_BUNDLED_AGENT_ARCHIVE_BYTES * CONCURRENT_ARCHIVE_CEILINGS +
  RUN_METADATA_RESERVE_BYTES;
const PREPARED_RESOURCE_REQUIRED_BYTES =
  MAX_BUNDLED_AGENT_ARCHIVE_BYTES * 2 + RUN_METADATA_RESERVE_BYTES;

export function bundledAgentFilesystemRequirements(
  packageStageSharesRunDevice: boolean,
): { packageStageBytes: number | null; runBytes: number } {
  return {
    runBytes: BUNDLED_AGENT_PREPARATION_REQUIRED_BYTES,
    packageStageBytes: packageStageSharesRunDevice
      ? null
      : MAX_BUNDLED_AGENT_ARCHIVE_BYTES,
  };
}

export interface ElectronRunResourceFailure {
  stage: "bundled_agent_preparation";
  cause: "disk_space_exhausted" | "resource_inspection_failed";
  owner: "electron_harness";
  exitCode: null;
  signal: null;
  availableBytes: number | null;
  requiredBytes: number;
}

export type ElectronRunResourceDecision =
  | { ok: true }
  | { ok: false; failure: ElectronRunResourceFailure };

export class ElectronRunResourceError extends Error {
  readonly failure: ElectronRunResourceFailure;

  constructor(failure: ElectronRunResourceFailure, options?: ErrorOptions) {
    super(
      failure.cause === "resource_inspection_failed"
        ? "Electron harness could not verify disk capacity before bundled Agent preparation."
        : "Electron harness disk capacity is insufficient for bundled Agent preparation.",
      options,
    );
    this.name = "ElectronRunResourceError";
    this.failure = failure;
  }
}

export function evaluateBundledAgentDiskCapacity(
  availableBytes: number | null,
  requiredBytes = BUNDLED_AGENT_PREPARATION_REQUIRED_BYTES,
): ElectronRunResourceDecision {
  if (
    availableBytes !== null &&
    Number.isSafeInteger(availableBytes) &&
    availableBytes >= requiredBytes
  ) {
    return { ok: true };
  }
  return {
    ok: false,
    failure: {
      stage: "bundled_agent_preparation",
      cause: availableBytes === null
        ? "resource_inspection_failed"
        : "disk_space_exhausted",
      owner: "electron_harness",
      exitCode: null,
      signal: null,
      availableBytes,
      requiredBytes,
    },
  };
}

export function preflightBundledAgentDiskCapacity(
  runRoot: string,
  packageBundledAgent = true,
): void {
  const runRequiredBytes = packageBundledAgent
    ? BUNDLED_AGENT_PREPARATION_REQUIRED_BYTES
    : PREPARED_RESOURCE_REQUIRED_BYTES;
  try {
    const runDevice = statSync(runRoot, { bigint: true }).dev;
    if (!packageBundledAgent) {
      requireFilesystemCapacity(runRoot, runRequiredBytes);
      return;
    }
    const packageStageRoot = tmpdir();
    let packageDevice: bigint;
    try {
      packageDevice = statSync(packageStageRoot, { bigint: true }).dev;
    } catch (error) {
      throw new ElectronRunResourceError(resourceFailure(
        "resource_inspection_failed",
        null,
        MAX_BUNDLED_AGENT_ARCHIVE_BYTES,
      ), { cause: error });
    }
    const requirements = bundledAgentFilesystemRequirements(
      runDevice === packageDevice,
    );
    if (requirements.packageStageBytes === null) {
      // Packaging staging is removed before the run-volume four-copy peak.
      requireFilesystemCapacity(runRoot, requirements.runBytes);
      return;
    }
    requireFilesystemCapacity(runRoot, runRequiredBytes);
    requireFilesystemCapacity(packageStageRoot, requirements.packageStageBytes);
  } catch (error) {
    if (error instanceof ElectronRunResourceError) throw error;
    // An unverifiable resource boundary fails closed without claiming exhaustion.
    throw new ElectronRunResourceError(resourceFailure(
      "resource_inspection_failed",
      null,
      runRequiredBytes,
    ), { cause: error });
  }
}

function requireFilesystemCapacity(path: string, requiredBytes: number): void {
  let availableBytes: number;
  try {
    const capacity = statfsSync(path, { bigint: true });
    const inspectedBytes = safeAvailableBytes(capacity.bavail, capacity.bsize);
    if (inspectedBytes === null) {
      throw new Error("Filesystem capacity exceeds the safe numeric range.");
    }
    availableBytes = inspectedBytes;
  } catch (error) {
    throw new ElectronRunResourceError(resourceFailure(
      "resource_inspection_failed",
      null,
      requiredBytes,
    ), { cause: error });
  }
  const decision = evaluateBundledAgentDiskCapacity(availableBytes, requiredBytes);
  if (!decision.ok) throw new ElectronRunResourceError(decision.failure);
}

export function safeAvailableBytes(
  availableBlocks: bigint,
  blockSize: bigint,
): number | null {
  if (availableBlocks < 0n || blockSize <= 0n) return null;
  const available = availableBlocks * blockSize;
  return available <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(available)
    : null;
}

export function bundledAgentPreparationError(error: unknown): ElectronRunResourceError | null {
  if (error instanceof ElectronRunResourceError) return error;
  if (
    systemErrorCode(error) !== "ENOSPC" &&
    !/\bENOSPC\b|no space left on device/iu.test(errorMessage(error))
  ) return null;
  return new ElectronRunResourceError({
    stage: "bundled_agent_preparation",
    cause: "disk_space_exhausted",
    owner: "electron_harness",
    exitCode: null,
    signal: null,
    availableBytes: null,
    requiredBytes: BUNDLED_AGENT_PREPARATION_REQUIRED_BYTES,
  }, { cause: error });
}

function resourceFailure(
  cause: ElectronRunResourceFailure["cause"],
  availableBytes: number | null,
  requiredBytes: number,
): ElectronRunResourceFailure {
  return {
    stage: "bundled_agent_preparation",
    cause,
    owner: "electron_harness",
    exitCode: null,
    signal: null,
    availableBytes,
    requiredBytes,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function systemErrorCode(error: unknown): string | null {
  let candidate: unknown = error;
  const seen = new Set<unknown>();
  while (candidate && typeof candidate === "object" && !seen.has(candidate)) {
    seen.add(candidate);
    const value = candidate as { cause?: unknown; code?: unknown };
    if (typeof value.code === "string") return value.code;
    candidate = value.cause;
  }
  return null;
}
