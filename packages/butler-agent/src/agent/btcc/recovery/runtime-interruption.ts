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
  return new OperationalInterruptionError(
    "runtime_unclassified_interruption",
    anchor,
    { kind: "runtime_remediation" },
    error,
  );
}
