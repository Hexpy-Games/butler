import {
  BLOCKER_EVIDENCE_RECEIPT_SCHEMA,
  TYPED_BLOCKER_SCHEMA,
  USER_BLOCKER_CODES,
  type BlockerEvidenceReceipt,
  type CompiledTurnContract,
  type TypedBlocker,
} from "./turn-contract-types.ts";

export function verifiedUserBlocker(input: {
  contract: CompiledTurnContract;
  blocker?: TypedBlocker | null;
  evidenceReceipts: readonly BlockerEvidenceReceipt[];
}): boolean {
  const blocker = input.blocker;
  if (!blocker || blocker.schema_version !== TYPED_BLOCKER_SCHEMA || blocker.owner !== "user") return false;
  if (!USER_BLOCKER_CODES.includes(blocker.code as typeof USER_BLOCKER_CODES[number])) return false;
  if (!blocker.requested_action?.trim() || blocker.requested_action.trim().length < 8) return false;
  return input.evidenceReceipts.some((receipt) =>
    receipt.schema_version === BLOCKER_EVIDENCE_RECEIPT_SCHEMA &&
    receipt.receipt_id === blocker.evidence_ref &&
    receipt.producer === "runtime" &&
    receipt.contract_id === input.contract.contract_id &&
    (!input.contract.target_workstream_id || receipt.workstream_id === input.contract.target_workstream_id) &&
    receipt.blocker_id === blocker.blocker_id &&
    receipt.owner === "user" &&
    receipt.code === blocker.code &&
    receipt.requested_action === blocker.requested_action &&
    receipt.verified === true,
  );
}
