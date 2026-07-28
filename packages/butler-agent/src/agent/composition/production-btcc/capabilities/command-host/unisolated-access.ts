import type { CapabilityExecutionContext } from "../contracts.ts";
import { OperationRejectedError } from "../../../../btcc/index.ts";

export function assertUnisolatedCommandAccess(
  context: CapabilityExecutionContext,
): void {
  const boundary = context.commandFilesystemBoundary;
  if (!boundary) return;
  if (
    boundary.kind === "isolated_workspace" &&
    boundary.deniedReadWriteRoots.length === 0
  ) {
    return;
  }
  if (context.accessMode === "full_access") return;
  const observation = boundary.kind === "read_only_observation";
  throw new OperationRejectedError(
    observation
      ? "command_observation_isolation_unavailable"
      : "command_filesystem_isolation_unavailable",
    observation
      ? "This host cannot enforce the admitted read-only local command boundary."
      : "This host cannot establish the required isolated command filesystem boundary.",
  );
}
