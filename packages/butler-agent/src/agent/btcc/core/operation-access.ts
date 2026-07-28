import type { OperationRequest } from "./operation-contracts.ts";
import type { PhaseEnvelope } from "./contracts.ts";
import { OperationRejectedError } from "./operation-rejection.ts";

export type TurnAccessMode = "full_access" | "ask_first" | "read_only";

export function turnAccessMode(envelope: PhaseEnvelope): TurnAccessMode {
  const value = envelope.modelSelection.controls.accessMode;
  if (value === "full_access" || value === "ask_first" || value === "read_only") {
    return value;
  }
  throw new Error("BTCC turn access mode is not admitted");
}

export function assertTurnAccessAllowsOperation(
  envelope: PhaseEnvelope,
  request: OperationRequest,
): void {
  if (!isPersistentMutation(request)) return;
  const mode = turnAccessMode(envelope);
  if (mode === "full_access") return;
  if (mode === "ask_first") {
    throw new OperationRejectedError(
      "principal_approval_required",
      "This operation requires a durable user approval before it can mutate a target.",
    );
  }
  throw new OperationRejectedError(
    "read_only_access_mutation_denied",
    "The selected read-only access mode cannot mutate a target.",
  );
}

function isPersistentMutation(request: OperationRequest): boolean {
  if (request.kind === "external_effect" || request.kind === "repository_promotion") {
    return true;
  }
  if (request.kind !== "workspace_artifact_action") return false;
  if (request.capabilityRef !== "run_command") return true;
  return request.input.state_effect === "mutation";
}
