import { allEvidenceObligationsSatisfied } from "./turn-contract-evidence.ts";
import { verifiedUserBlocker } from "./typed-user-blocker.ts";
import type {
  BlockerEvidenceReceipt,
  CompiledTurnContract,
  TurnCancellationReceipt,
  TurnEvidenceReceipt,
  TypedBlocker,
} from "./turn-contract-types.ts";

export function canDeliverTurnContract(input: {
  contract: CompiledTurnContract;
  evidenceReceipts: readonly TurnEvidenceReceipt[];
  blocker?: TypedBlocker | null;
  blockerEvidenceReceipts?: readonly BlockerEvidenceReceipt[];
  continuationCommitted?: boolean;
  cancellationReceipt?: TurnCancellationReceipt | null;
}): "deliver" | "waiting_user" | "yield_continuation" | "continue" {
  if (input.contract.terminal_rule === "answer") return "deliver";
  if (input.contract.action === "cancel_work") {
    if (validCancellationReceipt(input.contract, input.cancellationReceipt)) return "deliver";
    return input.continuationCommitted ? "yield_continuation" : "continue";
  }
  if (allEvidenceObligationsSatisfied({ contract: input.contract, receipts: input.evidenceReceipts })) return "deliver";
  if (verifiedUserBlocker({
    contract: input.contract,
    blocker: input.blocker,
    evidenceReceipts: input.blockerEvidenceReceipts ?? [],
  })) return "waiting_user";
  return input.continuationCommitted ? "yield_continuation" : "continue";
}

export function validCancellationReceipt(
  contract: CompiledTurnContract,
  receipt?: TurnCancellationReceipt | null,
): receipt is TurnCancellationReceipt {
  return Boolean(
    receipt && receipt.schema_version === "butler.workstream-claim-receipt.v1" &&
    receipt.operation === "cancel" && receipt.outcome === "cancelled" &&
    receipt.contract_id === contract.contract_id && receipt.workstream_id === contract.target_workstream_id &&
    receipt.project_id === contract.target_project_id && receipt.released_contract_id &&
    receipt.after_generation === receipt.before_generation + 1,
  );
}
