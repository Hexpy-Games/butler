import { createHash } from "crypto";
import type { WorkStreamClaimReceipt } from "./work-stream-claim-store.ts";
import type { WorkStreamRecord } from "./work-stream.ts";
import type { CompiledTurnContract, TurnContractAction } from "../turn/turn-contract-types.ts";

const NONTERMINAL_CONTRACT_STATES = new Set([
  "validated", "claimed", "executing", "reviewing", "waiting_user", "continuing",
]);

export function workStreamContractBindingError(input: {
  contract: CompiledTurnContract;
  record: WorkStreamRecord;
  workstreamId: string;
  allowedActions: TurnContractAction[];
}): string | null {
  if (!input.allowedActions.includes(input.contract.action)) return "workstream_contract_action_invalid";
  if (!NONTERMINAL_CONTRACT_STATES.has(input.contract.state)) return "workstream_contract_terminal";
  if (input.contract.target_workstream_id !== input.workstreamId || input.record.id !== input.workstreamId) {
    return "workstream_contract_target_mismatch";
  }
  if ((input.contract.target_project_id ?? null) !== (input.record.project_id ?? null)) {
    return "workstream_contract_project_mismatch";
  }
  return null;
}

export function claimedWorkStreamRecord(record: WorkStreamRecord, input: {
  contractId: string; turnId: string; receiptId: string; now: Date; leaseMs?: number;
}): WorkStreamRecord {
  return {
    ...record,
    state: "executing",
    current_phase: "execution",
    active_contract_id: input.contractId,
    claim_generation: record.record_generation ?? 1,
    claim_lease_expires_at: new Date(input.now.getTime() + (input.leaseMs ?? 5 * 60_000)).toISOString(),
    active_claim_receipt_id: input.receiptId,
    original_claim_receipt_id: input.receiptId,
    last_user_turn_id: input.turnId,
    record_generation: (record.record_generation ?? 1) + 1,
    updated_at: input.now.toISOString(),
  };
}

export function workStreamProvenanceError(
  record: WorkStreamRecord,
  input: { sessionId: string; chatId: string; projectId: string | null },
): string | null {
  if (!record.owner_session_id || !record.origin_chat_id) return "workstream_provenance_missing";
  return record.owner_session_id === input.sessionId && record.origin_chat_id === input.chatId &&
      (record.project_id ?? null) === input.projectId
    ? null
    : "workstream_scope_mismatch";
}

export function workStreamClaimLeaseExpired(record: WorkStreamRecord, now: Date): boolean {
  return Boolean(record.claim_lease_expires_at && Date.parse(record.claim_lease_expires_at) <= now.getTime());
}

export function workStreamClaimReceipt(input: {
  operation: WorkStreamClaimReceipt["operation"];
  outcome: WorkStreamClaimReceipt["outcome"];
  before: WorkStreamRecord;
  after: WorkStreamRecord;
  contractId: string;
  turnId: string;
  now: Date;
}): WorkStreamClaimReceipt {
  return {
    schema_version: "butler.workstream-claim-receipt.v1",
    receipt_id: workStreamClaimReceiptId(input.operation, input.contractId, input.before.id, input.before.record_generation ?? 1),
    operation: input.operation,
    outcome: input.outcome,
    workstream_id: input.before.id,
    contract_id: input.contractId,
    turn_id: input.turnId,
    before_generation: input.before.record_generation ?? 1,
    after_generation: input.after.record_generation ?? 1,
    lease_expires_at: input.after.claim_lease_expires_at ?? null,
    created_at: input.now.toISOString(),
  };
}

export function workStreamClaimReceiptId(
  operation: string,
  contractId: string,
  workstreamId: string,
  generation: number,
): string {
  const digest = createHash("sha256").update(`${operation}\n${contractId}\n${workstreamId}\n${generation}`).digest("hex").slice(0, 24);
  return `workstream-claim-${digest}`;
}

export function safeWorkStreamClaimId(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) throw new Error("workstream_claim_unsafe_id");
  return value;
}
