import { existsSync } from "fs";
import { join } from "path";
import { recordOperationalMetric } from "../../operations/metrics/operational-metrics.ts";
import { WorkStreamStore } from "../work/work-stream.ts";
import { WorkStreamClaimStore } from "../work/work-stream-claim-store.ts";
import { TurnContractStore } from "./turn-contract-store.ts";
import type { CompiledTurnContract } from "./turn-contract-types.ts";
import { writeJsonFileAtomic } from "../persistence/atomic-json-store.ts";

export interface TurnContractRecoveryResult {
  contractState: CompiledTurnContract["state"];
  action: CompiledTurnContract["action"];
  outcome: "ready" | "claim_preserved" | "continuation_preserved" | "failed_system";
  code: string;
}

export function reconcileNonTerminalTurnContracts(input: {
  butlerData: string;
}): TurnContractRecoveryResult[] {
  const store = new TurnContractStore(input.butlerData);
  const streams = new WorkStreamStore(input.butlerData, { autoRecover: false });
  return store.listNonTerminal().map((contract) => {
    const result = reconcileContract({ butlerData: input.butlerData, store, streams, contract });
    recordOperationalMetric({
      category: "runtime",
      name: "typed_turn_contract_recovery",
      status: result.outcome === "failed_system" ? "error" : "ok",
      value: 1,
      unit: "contracts",
      dimensions: {
        action: result.action,
        contractState: result.contractState,
        outcome: result.outcome,
        code: result.code,
      },
    }, { butlerData: input.butlerData });
    return result;
  });
}

function reconcileContract(input: {
  butlerData: string;
  store: TurnContractStore;
  streams: WorkStreamStore;
  contract: CompiledTurnContract;
}): TurnContractRecoveryResult {
  const { contract } = input;
  if (isLegacyPhantomProjectContract(contract)) {
    releaseContractClaims(input.streams, input.butlerData, contract.contract_id);
    return failContract(input, "legacy_phantom_project_target");
  }
  if (contract.state === "continuing" && !hasDurableContinuation(input.butlerData, contract)) {
    return failContract(input, "continuation_checkpoint_missing");
  }
  if (contract.target_workstream_id && claimRequired(contract.action)) {
    const stream = input.streams.read(contract.target_workstream_id);
    if (!stream) return failContract(input, "claimed_workstream_missing");
    if (stream.active_contract_id !== contract.contract_id) {
      return failContract(input, "workstream_claim_binding_mismatch");
    }
    return {
      contractState: contract.state,
      action: contract.action,
      outcome: contract.state === "continuing" ? "continuation_preserved" : "claim_preserved",
      code: contract.state === "continuing" ? "continuation_ready" : "claim_ready",
    };
  }
  return {
    contractState: contract.state,
    action: contract.action,
    outcome: contract.state === "continuing" ? "continuation_preserved" : "ready",
    code: contract.state === "continuing" ? "continuation_ready" : "contract_ready",
  };
}

function failContract(
  input: { store: TurnContractStore; contract: CompiledTurnContract },
  code: string,
): TurnContractRecoveryResult {
  const failed = input.store.recordTerminalDelivery({
    contractId: input.contract.contract_id,
    terminalState: "failed_system",
    expectedGeneration: input.contract.generation,
  }).contract;
  writeJsonFileAtomic(
    join(input.store.butlerData, "turn-contract-failures", `${failed.contract_id}.json`),
    {
      schema_version: "butler.turn-contract-failure.v1",
      contract_id: failed.contract_id,
      state: "failed_system",
      code,
      retryable: true,
      created_at: new Date().toISOString(),
    },
  );
  return {
    contractState: failed.state,
    action: failed.action,
    outcome: "failed_system",
    code,
  };
}

function isLegacyPhantomProjectContract(contract: CompiledTurnContract): boolean {
  if (
    contract.action !== "inspect" || contract.tracking_mode !== "none" ||
    contract.target_project_id || contract.target_workstream_id
  ) return false;
  return contract.required_evidence.some((obligation) =>
    obligation.deliverable === "status_report" &&
    obligation.target_kind === "project" &&
    (obligation.target_id === "active-project" || obligation.target_id === "active"));
}

function releaseContractClaims(
  streams: WorkStreamStore,
  butlerData: string,
  contractId: string,
): void {
  const claims = new WorkStreamClaimStore(butlerData);
  for (const summary of streams.list({ includeTerminal: true })) {
    const record = streams.read(summary.id);
    if (record?.active_contract_id !== contractId) continue;
    claims.release({
      contractId,
      workstreamId: record.id,
      expectedGeneration: record.record_generation ?? 1,
      turnId: record.last_user_turn_id ?? contractId,
    });
  }
}

function hasDurableContinuation(butlerData: string, contract: CompiledTurnContract): boolean {
  const latest = contract.continuation_commit_ids.at(-1);
  return Boolean(latest && existsSync(join(butlerData, "state", "turn-kernel", latest)));
}

function claimRequired(action: CompiledTurnContract["action"]): boolean {
  return action === "resume_work" || action === "modify_work" || action === "supply_user_action";
}
