import { join } from "path";
import { writeJsonFileAtomic } from "../../../persistence/atomic-json-store.ts";
import { TurnContractStore, type CompiledTurnContract } from "../../turn-contract.ts";

export const TURN_CONTRACT_SURFACE_INCONSISTENT_CODE = "turn_contract_surface_inconsistent" as const;

export class TurnContractSurfaceInconsistentError extends Error {
  readonly code = TURN_CONTRACT_SURFACE_INCONSISTENT_CODE;
  readonly retryable = true;

  constructor(
    readonly contractId: string,
    readonly obligationIds: string[],
  ) {
    super("The typed turn contract has no tool that can advance its focused obligations.");
    this.name = "TurnContractSurfaceInconsistentError";
  }
}

export function isTurnContractSurfaceInconsistentError(
  error: unknown,
): error is TurnContractSurfaceInconsistentError {
  return error instanceof TurnContractSurfaceInconsistentError || Boolean(
    error && typeof error === "object" &&
    (error as { code?: unknown }).code === TURN_CONTRACT_SURFACE_INCONSISTENT_CODE,
  );
}

export function failContractForSurfaceInconsistency(input: {
  butlerData: string;
  contract: CompiledTurnContract;
  attempt: number;
}): CompiledTurnContract {
  const store = new TurnContractStore(input.butlerData);
  const current = store.read(input.contract.contract_id) ?? input.contract;
  const failed = current.state === "failed_system"
    ? current
    : store.recordTerminalDelivery({
      contractId: current.contract_id,
      terminalState: "failed_system",
      expectedGeneration: current.generation,
    }).contract;
  writeJsonFileAtomic(
    join(input.butlerData, "turn-contract-failures", `${failed.contract_id}.json`),
    {
      schema_version: "butler.turn-contract-failure.v1",
      contract_id: failed.contract_id,
      state: "failed_system",
      code: TURN_CONTRACT_SURFACE_INCONSISTENT_CODE,
      retryable: true,
      redecision_attempt: input.attempt,
      obligation_ids: failed.required_evidence.map((item) => item.obligation_id).sort(),
      created_at: new Date().toISOString(),
    },
  );
  return failed;
}

export function surfaceRedecisionDiagnostic(error: TurnContractSurfaceInconsistentError): string {
  return [
    "## Structural Contract Diagnostic",
    "The previous typed decision produced no authorized tool that could advance its obligations.",
    `failed_contract_id: ${error.contractId}`,
    `focused_obligation_ids: ${error.obligationIds.join(", ") || "none"}`,
    "Choose a fresh typed action and scope from the schema. Do not repeat the incompatible action/scope combination.",
    "Interpret the original current user instruction yourself; runtime has not inferred replacement intent from its wording.",
  ].join("\n");
}
