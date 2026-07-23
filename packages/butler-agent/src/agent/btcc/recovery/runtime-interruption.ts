import {
  isBtccOperationalInterruption,
  OperationalInterruptionError,
  type OperationalCheckpointAnchor,
} from "./operational-interruption.ts";

export function runtimeInterruption(
  error: unknown,
  anchor: OperationalCheckpointAnchor,
): OperationalInterruptionError {
  if (isBtccOperationalInterruption(error)) return error;
  if (isSqliteWriteContention(error)) {
    return new OperationalInterruptionError(
      "sqlite_write_contention",
      anchor,
      { kind: "automatic_storage_recovery" },
      error,
    );
  }
  return new OperationalInterruptionError(
    "runtime_unclassified_interruption",
    anchor,
    { kind: "runtime_remediation" },
    error,
  );
}

function isSqliteWriteContention(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { code?: unknown; errno?: unknown };
  return value.code === "SQLITE_BUSY" || value.code === "SQLITE_LOCKED" ||
    value.errno === 5 || value.errno === 6;
}
