import { join } from "path";
import { readJsonFile, writeJsonFileAtomic } from "../persistence/atomic-json-store.ts";
import type {
  BlockerEvidenceReceipt,
  CompiledTurnContract,
  TypedBlocker,
} from "../turn/turn-contract-types.ts";
import { WorkStreamBlockerStore } from "./work-stream-blocker-store.ts";
import { reconcilePendingWorkStreamTransactions } from "./work-stream-transaction-recovery.ts";
import {
  WorkStreamStore,
  type WorkStreamRecord,
  workStreamResumable,
} from "./work-stream.ts";
import {
  authorizeWorkStreamMutation,
  commitWorkStreamMutation,
  type WorkStreamContractAuthorization,
  type WorkStreamMutationContext,
  type WorkStreamMutationOperation,
  withWorkStreamMutationAuthority,
} from "./work-stream-mutation-authority.ts";
import {
  claimedWorkStreamRecord,
  safeWorkStreamClaimId,
  workStreamClaimLeaseExpired,
  workStreamClaimReceipt,
  workStreamClaimReceiptId,
  workStreamContractBindingError,
  workStreamProvenanceError,
} from "./work-stream-claim-records.ts";

export interface WorkStreamClaimReceipt {
  schema_version: "butler.workstream-claim-receipt.v1";
  receipt_id: string;
  operation: "claim" | "renew" | "release" | "cancel" | "wait_user";
  outcome: "claimed" | "replayed" | "reclaimed" | "renewed" | "released" | "cancelled" | "waiting_user";
  workstream_id: string;
  contract_id: string;
  turn_id: string;
  before_generation: number;
  after_generation: number;
  lease_expires_at: string | null;
  blocker_id?: string;
  released_contract_id?: string;
  project_id?: string;
  created_at: string;
}

export type WorkStreamClaimResult =
  | { ok: true; record: WorkStreamRecord; receipt: WorkStreamClaimReceipt; replayed: boolean }
  | { ok: false; code: string };

export class WorkStreamClaimStore {
  private readonly streams: WorkStreamStore;
  private readonly receiptsDir: string;
  private readonly blockers: WorkStreamBlockerStore;

  constructor(readonly butlerData: string) {
    reconcilePendingWorkStreamTransactions({ butlerData });
    this.streams = new WorkStreamStore(butlerData, { autoRecover: false });
    this.receiptsDir = join(butlerData, "workstream-claim-receipts");
    this.blockers = new WorkStreamBlockerStore(butlerData);
  }

  claim(input: {
    contract: CompiledTurnContract;
    workstreamId: string;
    sessionId: string;
    chatId: string;
    projectId: string | null;
    turnId: string;
    expectedGeneration: number;
    leaseMs?: number;
    now?: Date;
    faultAfterWorkStreamWrite?: boolean;
  }): WorkStreamClaimResult {
    if (
      input.contract.action !== "start_work" &&
      input.contract.action !== "resume_work" &&
      input.contract.action !== "modify_work"
    ) {
      return { ok: false, code: "workstream_claim_action_invalid" };
    }
    return this.withLock(input.workstreamId, "claim", input.contract.contract_id, input.now, { contractId: input.contract.contract_id }, (context) => {
      const record = this.streams.read(input.workstreamId);
      if (!record) return { ok: false, code: "workstream_not_found" };
      const scopeError = workStreamProvenanceError(record, input);
      if (scopeError) return { ok: false, code: scopeError };
      const bindingError = workStreamContractBindingError({
        contract: input.contract,
        record,
        workstreamId: input.workstreamId,
        allowedActions: ["start_work", "resume_work", "modify_work"],
      });
      if (bindingError) return { ok: false, code: bindingError };
      if (record.state === "waiting_user") return { ok: false, code: "workstream_waiting_user_requires_supply" };
      if (!workStreamResumable(record)) return { ok: false, code: "workstream_not_resumable" };
      if (record.active_contract_id === input.contract.contract_id) {
        return this.replayOrRepairClaim(record, input);
      }
      if (record.record_generation !== input.expectedGeneration) return { ok: false, code: "workstream_claim_generation_conflict" };
      const now = input.now ?? new Date();
      const reclaimed = Boolean(record.active_contract_id && workStreamClaimLeaseExpired(record, now));
      if (record.active_contract_id && !reclaimed) return { ok: false, code: "workstream_claim_conflict" };
      const receiptId = workStreamClaimReceiptId("claim", input.contract.contract_id, record.id, record.record_generation ?? 1);
      const updated = claimedWorkStreamRecord(record, {
        contractId: input.contract.contract_id,
        turnId: input.turnId,
        receiptId,
        now,
        leaseMs: input.leaseMs,
      });
      commitWorkStreamMutation({ butlerData: this.butlerData, context, record: updated, expectedGeneration: record.record_generation ?? 1 });
      if (input.faultAfterWorkStreamWrite) throw new Error("injected_claim_failure_after_workstream_write");
      const receipt = this.writeReceipt({
        schema_version: "butler.workstream-claim-receipt.v1",
        receipt_id: receiptId,
        operation: "claim",
        outcome: reclaimed ? "reclaimed" : "claimed",
        workstream_id: record.id,
        contract_id: input.contract.contract_id,
        turn_id: input.turnId,
        before_generation: record.record_generation ?? 1,
        after_generation: updated.record_generation ?? 1,
        lease_expires_at: updated.claim_lease_expires_at ?? null,
        created_at: now.toISOString(),
      });
      return { ok: true, record: updated, receipt, replayed: false };
    });
  }

  renew(input: {
    contractId: string;
    workstreamId: string;
    expectedGeneration: number;
    turnId: string;
    leaseMs?: number;
    now?: Date;
  }): WorkStreamClaimResult {
    return this.withLock(input.workstreamId, "renew_claim", input.contractId, input.now, { contractId: input.contractId }, (context) => {
      const record = this.streams.read(input.workstreamId);
      if (!record || record.active_contract_id !== input.contractId) return { ok: false, code: "workstream_claim_missing" };
      if (record.record_generation !== input.expectedGeneration) return { ok: false, code: "workstream_claim_generation_conflict" };
      const now = input.now ?? new Date();
      const receiptId = workStreamClaimReceiptId("renew", input.contractId, record.id, record.record_generation ?? 1);
      const updated: WorkStreamRecord = {
        ...record,
        record_generation: (record.record_generation ?? 1) + 1,
        claim_lease_expires_at: new Date(now.getTime() + (input.leaseMs ?? 5 * 60_000)).toISOString(),
        active_claim_receipt_id: receiptId,
        updated_at: now.toISOString(),
      };
      commitWorkStreamMutation({ butlerData: this.butlerData, context, record: updated, expectedGeneration: record.record_generation ?? 1 });
      const receipt = this.writeReceipt(workStreamClaimReceipt({ operation: "renew", outcome: "renewed", before: record, after: updated, contractId: input.contractId, turnId: input.turnId, now }));
      return { ok: true, record: updated, receipt, replayed: false };
    });
  }

  release(input: {
    contractId: string;
    workstreamId: string;
    expectedGeneration: number;
    turnId: string;
    now?: Date;
  }): WorkStreamClaimResult {
    return this.withLock(input.workstreamId, "release_claim", input.contractId, input.now, {
      contractId: input.contractId,
      releasedContractId: input.contractId,
    }, (context) => {
      const record = this.streams.read(input.workstreamId);
      if (!record) return { ok: false, code: "workstream_not_found" };
      if (!record.active_contract_id) {
        const prior = record.active_claim_receipt_id
          ? this.readReceipt(record.active_claim_receipt_id)
          : null;
        return prior?.operation === "release" && prior.contract_id === input.contractId
          ? { ok: true, record, receipt: prior, replayed: true }
          : { ok: false, code: "workstream_claim_missing" };
      }
      if (record.active_contract_id !== input.contractId) {
        return { ok: false, code: "workstream_claim_conflict" };
      }
      if (record.record_generation !== input.expectedGeneration) {
        return { ok: false, code: "workstream_claim_generation_conflict" };
      }
      const now = input.now ?? new Date();
      const receiptId = workStreamClaimReceiptId(
        "release",
        input.contractId,
        record.id,
        record.record_generation ?? 1,
      );
      const updated: WorkStreamRecord = {
        ...record,
        active_contract_id: null,
        claim_lease_expires_at: null,
        active_claim_receipt_id: receiptId,
        active_blocker_id: null,
        active_blocker_evidence_id: null,
        record_generation: (record.record_generation ?? 1) + 1,
        updated_at: now.toISOString(),
      };
      const authorized = authorizeWorkStreamMutation(context, {
        contractId: input.contractId,
        releasedContractId: input.contractId,
      });
      commitWorkStreamMutation({
        butlerData: this.butlerData,
        context: authorized,
        record: updated,
        expectedGeneration: record.record_generation ?? 1,
      });
      const receipt = this.writeReceipt({
        ...workStreamClaimReceipt({
          operation: "release",
          outcome: "released",
          before: record,
          after: updated,
          contractId: input.contractId,
          turnId: input.turnId,
          now,
        }),
        receipt_id: receiptId,
        released_contract_id: input.contractId,
      });
      return { ok: true, record: updated, receipt, replayed: false };
    });
  }

  cancel(input: {
    contract: CompiledTurnContract;
    workstreamId: string;
    expectedGeneration: number;
    turnId: string;
    now?: Date;
    faultAfterReceiptWrite?: boolean;
  }): WorkStreamClaimResult {
    return this.withLock(input.workstreamId, "contract_cancel", input.contract.contract_id, input.now, { contractId: input.contract.contract_id }, (context) => {
      const record = this.streams.read(input.workstreamId);
      if (!record) return { ok: false, code: "workstream_not_found" };
      const bindingError = workStreamContractBindingError({
        contract: input.contract,
        record,
        workstreamId: input.workstreamId,
        allowedActions: ["cancel_work"],
      });
      if (bindingError) return { ok: false, code: bindingError };
      if (record.state === "cancelled" && record.active_claim_receipt_id) {
        const prior = this.readReceipt(record.active_claim_receipt_id);
        if (prior?.operation === "cancel" && prior.contract_id === input.contract.contract_id) {
          return { ok: true, record, receipt: prior, replayed: true };
        }
      }
      if (["complete", "failed", "cancelled"].includes(record.state)) return { ok: false, code: `workstream_terminal_${record.state}` };
      if (!record.active_contract_id) return { ok: false, code: "workstream_claim_missing" };
      if (record.record_generation !== input.expectedGeneration) return { ok: false, code: "workstream_claim_generation_conflict" };
      const now = input.now ?? new Date();
      const receiptId = workStreamClaimReceiptId("cancel", input.contract.contract_id, record.id, record.record_generation ?? 1);
      const receipt = this.writeReceipt({
        ...workStreamClaimReceipt({ operation: "cancel", outcome: "cancelled", before: record, after: { ...record, record_generation: (record.record_generation ?? 1) + 1 }, contractId: input.contract.contract_id, turnId: input.turnId, now }),
        receipt_id: receiptId,
        lease_expires_at: null,
        released_contract_id: record.active_contract_id,
        project_id: record.project_id ?? undefined,
      });
      if (input.faultAfterReceiptWrite) throw new Error("injected_cancellation_failure_after_receipt_write");
      const updated: WorkStreamRecord = {
        ...record,
        state: "cancelled",
        current_phase: null,
        active_step_id: null,
        active_contract_id: null,
        claim_lease_expires_at: null,
        active_claim_receipt_id: receipt.receipt_id,
        active_blocker_id: null,
        active_blocker_evidence_id: null,
        record_generation: receipt.after_generation,
        updated_at: now.toISOString(),
      };
      const authorized = authorizeWorkStreamMutation(context, {
        contractId: input.contract.contract_id,
        releasedContractId: record.active_contract_id,
      });
      commitWorkStreamMutation({ butlerData: this.butlerData, context: authorized, record: updated, expectedGeneration: record.record_generation ?? 1 });
      return { ok: true, record: updated, receipt, replayed: false };
    });
  }

  cancelByPrincipalTurn(input: {
    workstreamId: string;
    contractId: string;
    turnId: string;
    expectedGeneration: number;
    now?: Date;
  }): WorkStreamClaimResult {
    return this.withLock(
      input.workstreamId,
      "contract_cancel",
      input.turnId,
      input.now,
      { contractId: input.contractId },
      (context) => {
        const record = this.streams.read(input.workstreamId);
        if (!record) return { ok: false, code: "workstream_not_found" };
        if (record.last_user_turn_id !== input.turnId) {
          return { ok: false, code: "workstream_principal_turn_mismatch" };
        }
        if (record.state === "cancelled" && record.active_claim_receipt_id) {
          const prior = this.readReceipt(record.active_claim_receipt_id);
          if (prior?.operation === "cancel" && prior.turn_id === input.turnId) {
            return { ok: true, record, receipt: prior, replayed: true };
          }
        }
        if (["complete", "failed", "cancelled"].includes(record.state)) {
          return { ok: false, code: `workstream_terminal_${record.state}` };
        }
        if (record.active_contract_id !== input.contractId) {
          return { ok: false, code: "workstream_claim_missing" };
        }
        if (record.record_generation !== input.expectedGeneration) {
          return { ok: false, code: "workstream_claim_generation_conflict" };
        }
        const now = input.now ?? new Date();
        const contractId = input.contractId;
        const receiptId = workStreamClaimReceiptId("cancel", contractId, record.id, record.record_generation ?? 1);
        const receipt = this.writeReceipt({
          ...workStreamClaimReceipt({
            operation: "cancel",
            outcome: "cancelled",
            before: record,
            after: { ...record, record_generation: (record.record_generation ?? 1) + 1 },
            contractId,
            turnId: input.turnId,
            now,
          }),
          receipt_id: receiptId,
          lease_expires_at: null,
          released_contract_id: contractId,
          project_id: record.project_id ?? undefined,
        });
        const updated: WorkStreamRecord = {
          ...record,
          state: "cancelled",
          current_phase: null,
          active_step_id: null,
          active_contract_id: null,
          claim_lease_expires_at: null,
          active_claim_receipt_id: receipt.receipt_id,
          active_blocker_id: null,
          active_blocker_evidence_id: null,
          record_generation: receipt.after_generation,
          updated_at: now.toISOString(),
        };
        const authorized = authorizeWorkStreamMutation(context, {
          contractId,
          releasedContractId: contractId,
        });
        commitWorkStreamMutation({
          butlerData: this.butlerData,
          context: authorized,
          record: updated,
          expectedGeneration: record.record_generation ?? 1,
        });
        return { ok: true, record: updated, receipt, replayed: false };
      },
    );
  }

  waitForUser(input: {
    contract: CompiledTurnContract;
    workstreamId: string;
    expectedGeneration: number;
    turnId: string;
    blocker: TypedBlocker;
    blockerEvidenceReceipts: readonly BlockerEvidenceReceipt[];
    now?: Date;
    faultAt?: "after_artifacts_write" | "after_workstream_write";
  }): WorkStreamClaimResult {
    return this.blockers.wait(input);
  }

  supplyUserAction(input: Parameters<WorkStreamClaimStore["claim"]>[0] & {
    blockerId: string;
  }): WorkStreamClaimResult {
    if (input.contract.action !== "supply_user_action" || input.contract.blocker_id !== input.blockerId) {
      return { ok: false, code: "workstream_supply_action_mismatch" };
    }
    return this.withLock(input.workstreamId, "supply_user_action", input.contract.contract_id, input.now, {
      contractId: input.contract.contract_id,
      blockerId: input.blockerId,
    }, (context) => {
      const record = this.streams.read(input.workstreamId);
      if (!record || record.state !== "waiting_user") return { ok: false, code: "workstream_not_waiting_user" };
      const scopeError = workStreamProvenanceError(record, input);
      if (scopeError) return { ok: false, code: scopeError };
      const bindingError = workStreamContractBindingError({
        contract: input.contract,
        record,
        workstreamId: input.workstreamId,
        allowedActions: ["supply_user_action"],
      });
      if (bindingError) return { ok: false, code: bindingError };
      if (record.active_blocker_id !== input.blockerId) return { ok: false, code: "workstream_supply_blocker_mismatch" };
      const blockerError = this.blockers.verifySupply(record, input.blockerId);
      if (blockerError) return { ok: false, code: blockerError };
      if (record.record_generation !== input.expectedGeneration) return { ok: false, code: "workstream_claim_generation_conflict" };
      const now = input.now ?? new Date();
      const receiptId = workStreamClaimReceiptId("claim", input.contract.contract_id, record.id, record.record_generation ?? 1);
      const updated = claimedWorkStreamRecord(record, { contractId: input.contract.contract_id, turnId: input.turnId, receiptId, now, leaseMs: input.leaseMs });
      updated.active_blocker_id = null;
      updated.active_blocker_evidence_id = null;
      commitWorkStreamMutation({ butlerData: this.butlerData, context, record: updated, expectedGeneration: record.record_generation ?? 1 });
      const receipt = this.writeReceipt(workStreamClaimReceipt({ operation: "claim", outcome: "claimed", before: record, after: updated, contractId: input.contract.contract_id, turnId: input.turnId, now }));
      return { ok: true, record: updated, receipt, replayed: false };
    });
  }

  readReceipt(receiptId: string): WorkStreamClaimReceipt | null {
    return readJsonFile<WorkStreamClaimReceipt>(join(this.receiptsDir, `${safeWorkStreamClaimId(receiptId)}.json`));
  }

  recoverPendingBlockers(): Array<{ transactionId: string; status: "committed" | "conflict" | "deferred" }> {
    return this.blockers.recoverPending();
  }

  private replayOrRepairClaim(record: WorkStreamRecord, input: Parameters<WorkStreamClaimStore["claim"]>[0]): WorkStreamClaimResult {
    const receiptId = record.original_claim_receipt_id ?? workStreamClaimReceiptId("claim", input.contract.contract_id, record.id, record.claim_generation ?? 1);
    const existing = this.readReceipt(receiptId);
    const receipt = existing ?? this.writeReceipt({
      schema_version: "butler.workstream-claim-receipt.v1",
      receipt_id: receiptId,
      operation: "claim",
      outcome: "replayed",
      workstream_id: record.id,
      contract_id: input.contract.contract_id,
      turn_id: record.last_user_turn_id ?? input.turnId,
      before_generation: record.claim_generation ?? Math.max(1, (record.record_generation ?? 1) - 1),
      after_generation: record.record_generation ?? 1,
      lease_expires_at: record.claim_lease_expires_at ?? null,
      created_at: record.updated_at,
    });
    return { ok: true, record, receipt, replayed: true };
  }

  private writeReceipt(receipt: WorkStreamClaimReceipt): WorkStreamClaimReceipt {
    const existing = this.readReceipt(receipt.receipt_id);
    if (existing) return existing;
    writeJsonFileAtomic(join(this.receiptsDir, `${safeWorkStreamClaimId(receipt.receipt_id)}.json`), receipt);
    return receipt;
  }

  private withLock<T extends WorkStreamClaimResult>(
    id: string,
    operation: WorkStreamMutationOperation,
    ownerId: string,
    now: Date | undefined,
    authorization: WorkStreamContractAuthorization,
    action: (context: WorkStreamMutationContext) => T,
  ): T {
    const result = withWorkStreamMutationAuthority({
      butlerData: this.butlerData,
      workstreamId: id,
      operation,
      ownerId,
      now,
      authorization,
      action,
    });
    return result ?? { ok: false, code: "workstream_claim_conflict" } as T;
  }
}
