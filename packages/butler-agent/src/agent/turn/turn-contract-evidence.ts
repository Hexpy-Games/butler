import {
  TURN_EVIDENCE_RECEIPT_SCHEMA,
  type CompiledTurnContract,
  type RequiredEvidenceObligation,
  type TurnEvidenceReceipt,
} from "./turn-contract-types.ts";

export function evidenceObligationSatisfied(input: {
  contract: CompiledTurnContract;
  obligation: RequiredEvidenceObligation;
  receipts: readonly TurnEvidenceReceipt[];
}): boolean {
  const matching = uniqueReceipts(input.receipts).filter((receipt) => receiptMatches({
    contract: input.contract,
    obligation: input.obligation,
    receipt,
  }));
  if (input.obligation.expected_item_ids.length > 0) {
    const itemIds = new Set(matching.flatMap((receipt) => receipt.item_ids));
    return matching.length >= input.obligation.cardinality &&
      input.obligation.expected_item_ids.every((id) => itemIds.has(id));
  }
  return matching.length >= input.obligation.cardinality;
}

export function allEvidenceObligationsSatisfied(input: {
  contract: CompiledTurnContract;
  receipts: readonly TurnEvidenceReceipt[];
}): boolean {
  return input.contract.required_evidence.every((obligation) => evidenceObligationSatisfied({
    contract: input.contract,
    obligation,
    receipts: input.receipts,
  }));
}

export function assertEvidenceReceiptForContract(
  contract: CompiledTurnContract,
  receipt: TurnEvidenceReceipt,
): RequiredEvidenceObligation {
  const obligation = contract.required_evidence.find((candidate) => candidate.obligation_id === receipt.obligation_id);
  if (!obligation || !receiptMatches({ contract, obligation, receipt })) {
    throw new Error("turn_contract_evidence_receipt_mismatch");
  }
  return obligation;
}

function receiptMatches(input: {
  contract: CompiledTurnContract;
  obligation: RequiredEvidenceObligation;
  receipt: TurnEvidenceReceipt;
}): boolean {
  const { contract, obligation, receipt } = input;
  return receipt.schema_version === TURN_EVIDENCE_RECEIPT_SCHEMA &&
    receipt.verified === true &&
    receipt.contract_id === contract.contract_id &&
    receipt.obligation_id === obligation.obligation_id &&
    receipt.deliverable === obligation.deliverable &&
    receipt.target_kind === obligation.target_kind &&
    receipt.target_id === obligation.target_id &&
    receipt.obligation_generation === obligation.generation &&
    receipt.evidence_class === obligation.evidence_class &&
    obligation.allowed_producers.includes(receipt.producer);
}

function uniqueReceipts(receipts: readonly TurnEvidenceReceipt[]): TurnEvidenceReceipt[] {
  return [...new Map(receipts.map((receipt) => [receipt.receipt_id, receipt])).values()];
}
