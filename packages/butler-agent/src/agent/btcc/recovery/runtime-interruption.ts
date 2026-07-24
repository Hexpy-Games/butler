import {
  isBtccOperationalInterruption,
  OperationalInterruptionError,
  type OperationalCheckpointAnchor,
} from "./operational-interruption.ts";
import { isSqliteContention } from "../../../foundation/sqlite-contention.ts";

export function runtimeInterruption(
  error: unknown,
  anchor: OperationalCheckpointAnchor,
): OperationalInterruptionError {
  if (isBtccOperationalInterruption(error)) return error;
  if (isSqliteContention(error)) {
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
