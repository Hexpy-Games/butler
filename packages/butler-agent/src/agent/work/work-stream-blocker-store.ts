import { createHash } from "crypto";
import { join } from "path";
import { readJsonFile, writeJsonFileAtomic } from "../persistence/atomic-json-store.ts";
import { verifiedUserBlocker } from "../turn/typed-user-blocker.ts";
import {
  BLOCKER_EVIDENCE_RECEIPT_SCHEMA,
  TYPED_BLOCKER_SCHEMA,
  USER_BLOCKER_CODES,
  type BlockerEvidenceReceipt,
  type CompiledTurnContract,
  type TypedBlocker,
} from "../turn/turn-contract-types.ts";
import { WorkStreamStore, type WorkStreamRecord } from "./work-stream.ts";
import type { WorkStreamClaimReceipt, WorkStreamClaimResult } from "./work-stream-claim-store.ts";
import { safeWorkStreamClaimId, workStreamClaimReceipt, workStreamClaimReceiptId, workStreamContractBindingError } from "./work-stream-claim-records.ts";
import { commitWorkStreamMutation, withWorkStreamMutationAuthority, workStreamRecordFingerprint } from "./work-stream-mutation-authority.ts";
import { reconcilePendingWorkStreamTransactions } from "./work-stream-transaction-recovery.ts";

export interface BlockerJournal {
  schema_version: "butler.workstream-blocker-transaction.v1";
  transaction_id: string;
  state: "prepared" | "artifacts_committed" | "committed" | "conflict";
  before_workstream: WorkStreamRecord;
  after_workstream: WorkStreamRecord;
  before_fingerprint: string;
  after_fingerprint: string;
  blocker: TypedBlocker;
  evidence: BlockerEvidenceReceipt;
  claim_receipt: WorkStreamClaimReceipt;
  updated_at: string;
}

export class WorkStreamBlockerStore {
  private readonly streams: WorkStreamStore;
  private readonly transactionsDir: string;
  private readonly blockersDir: string;
  private readonly evidenceDir: string;
  private readonly claimReceiptsDir: string;

  constructor(readonly butlerData: string) {
    reconcilePendingWorkStreamTransactions({ butlerData });
    this.streams = new WorkStreamStore(butlerData, { autoRecover: false });
    this.transactionsDir = join(butlerData, "workstream-blocker-transactions");
    this.blockersDir = join(butlerData, "workstream-blockers");
    this.evidenceDir = join(butlerData, "workstream-blocker-evidence");
    this.claimReceiptsDir = join(butlerData, "workstream-claim-receipts");
  }

  wait(input: {
    contract: CompiledTurnContract;
    workstreamId: string;
    expectedGeneration: number;
    turnId: string;
    blocker: TypedBlocker;
    blockerEvidenceReceipts: readonly BlockerEvidenceReceipt[];
    now?: Date;
    faultAt?: "after_artifacts_write" | "after_workstream_write";
  }): WorkStreamClaimResult {
    if (!verifiedUserBlocker({ contract: input.contract, blocker: input.blocker, evidenceReceipts: input.blockerEvidenceReceipts })) {
      return { ok: false, code: "workstream_user_blocker_unverified" };
    }
    const evidence = input.blockerEvidenceReceipts.find((item) => item.receipt_id === input.blocker.evidence_ref)!;
    const now = input.now ?? new Date();
    const result = withWorkStreamMutationAuthority({
      butlerData: this.butlerData,
      workstreamId: input.workstreamId,
      operation: "wait_user",
      ownerId: `blocker:${input.contract.contract_id}:${input.blocker.blocker_id}`,
      authorization: { contractId: input.contract.contract_id, blockerId: input.blocker.blocker_id },
      now,
      action: (context) => {
        const record = this.streams.read(input.workstreamId);
        if (!record || record.active_contract_id !== input.contract.contract_id) return { ok: false, code: "workstream_claim_missing" } as const;
        const bindingError = workStreamContractBindingError({
          contract: input.contract,
          record,
          workstreamId: input.workstreamId,
          allowedActions: ["resume_work", "modify_work"],
        });
        if (bindingError) return { ok: false, code: bindingError } as const;
        if (record.record_generation !== input.expectedGeneration) return { ok: false, code: "workstream_claim_generation_conflict" } as const;
        const receiptId = workStreamClaimReceiptId("wait_user", input.contract.contract_id, record.id, record.record_generation ?? 1);
        const after: WorkStreamRecord = {
          ...record,
          state: "waiting_user",
          active_blocker_id: input.blocker.blocker_id,
          active_blocker_evidence_id: evidence.receipt_id,
          active_claim_receipt_id: receiptId,
          record_generation: (record.record_generation ?? 1) + 1,
          updated_at: now.toISOString(),
        };
        const receipt = {
          ...workStreamClaimReceipt({ operation: "wait_user", outcome: "waiting_user", before: record, after, contractId: input.contract.contract_id, turnId: input.turnId, now }),
          blocker_id: input.blocker.blocker_id,
        };
        const journal = this.prepareJournal(record, after, input.blocker, evidence, receipt, now);
        writeJsonFileAtomic(this.transactionPath(journal.transaction_id), journal);
        this.persistArtifacts(journal);
        writeJsonFileAtomic(this.transactionPath(journal.transaction_id), { ...journal, state: "artifacts_committed", updated_at: now.toISOString() });
        if (input.faultAt === "after_artifacts_write") {
          return { ok: false, code: "workstream_blocker_persistence_interrupted" } as const;
        }
        commitWorkStreamMutation({ butlerData: this.butlerData, context, record: after, expectedGeneration: record.record_generation ?? 1 });
        if (input.faultAt === "after_workstream_write") {
          return { ok: false, code: "workstream_blocker_persistence_interrupted" } as const;
        }
        this.markCommitted(journal);
        return { ok: true, record: after, receipt, replayed: false } as const;
      },
    });
    return result ?? { ok: false, code: "workstream_claim_conflict" };
  }

  recoverPending(): Array<{ transactionId: string; status: "committed" | "conflict" | "deferred" }> {
    return reconcilePendingWorkStreamTransactions({ butlerData: this.butlerData })
      .filter((result) => result.kind === "blocker")
      .map(({ transactionId, status }) => ({ transactionId, status }));
  }

  verifySupply(record: WorkStreamRecord, blockerId: string): string | null {
    if (!record.active_blocker_evidence_id) return "workstream_blocker_evidence_missing";
    const blocker = readJsonFile<TypedBlocker>(this.blockerPath(blockerId));
    const evidence = readJsonFile<BlockerEvidenceReceipt>(this.evidencePath(record.active_blocker_evidence_id));
    if (!blocker || !evidence) return "workstream_blocker_evidence_mismatch";
    const transactionId = blockerTransactionId(evidence.contract_id, record.id, blockerId, (record.record_generation ?? 1) - 1);
    const journal = readJsonFile<BlockerJournal>(this.transactionPath(transactionId));
    if (
      blocker.schema_version !== TYPED_BLOCKER_SCHEMA || blocker.owner !== "user" ||
      !USER_BLOCKER_CODES.includes(blocker.code as typeof USER_BLOCKER_CODES[number]) ||
      !blocker.requested_action?.trim() || blocker.requested_action.trim().length < 8 ||
      evidence.schema_version !== BLOCKER_EVIDENCE_RECEIPT_SCHEMA || evidence.producer !== "runtime" || evidence.owner !== "user" ||
      blocker.blocker_id !== blockerId || blocker.evidence_ref !== evidence.receipt_id ||
      evidence.workstream_id !== record.id || evidence.blocker_id !== blockerId || evidence.code !== blocker.code ||
      evidence.requested_action !== blocker.requested_action || evidence.verified !== true ||
      !journal || journal.state !== "committed" || journal.evidence.contract_id !== evidence.contract_id ||
      journal.before_workstream.active_contract_id !== evidence.contract_id ||
      JSON.stringify(journal.blocker) !== JSON.stringify(blocker) || JSON.stringify(journal.evidence) !== JSON.stringify(evidence) ||
      journal.after_fingerprint !== workStreamRecordFingerprint(record)
    ) return "workstream_blocker_evidence_mismatch";
    return null;
  }

  private prepareJournal(before: WorkStreamRecord, after: WorkStreamRecord, blocker: TypedBlocker, evidence: BlockerEvidenceReceipt, claimReceipt: WorkStreamClaimReceipt, now: Date): BlockerJournal {
    return {
      schema_version: "butler.workstream-blocker-transaction.v1",
      transaction_id: blockerTransactionId(evidence.contract_id, before.id, blocker.blocker_id, before.record_generation ?? 1),
      state: "prepared",
      before_workstream: before,
      after_workstream: after,
      before_fingerprint: workStreamRecordFingerprint(before),
      after_fingerprint: workStreamRecordFingerprint(after),
      blocker,
      evidence,
      claim_receipt: claimReceipt,
      updated_at: now.toISOString(),
    };
  }

  private persistArtifacts(journal: BlockerJournal): void {
    this.writeIdentity(this.blockerPath(journal.blocker.blocker_id), journal.blocker);
    this.writeIdentity(this.evidencePath(journal.evidence.receipt_id), journal.evidence);
    this.writeIdentity(this.claimReceiptPath(journal.claim_receipt.receipt_id), journal.claim_receipt);
  }

  private markCommitted(journal: BlockerJournal): void {
    writeJsonFileAtomic(this.transactionPath(journal.transaction_id), { ...journal, state: "committed", updated_at: new Date().toISOString() });
  }

  private writeIdentity(path: string, value: unknown): void {
    const existing = readJsonFile<unknown>(path);
    if (existing && JSON.stringify(existing) !== JSON.stringify(value)) throw new Error("workstream_blocker_identity_conflict");
    if (!existing) writeJsonFileAtomic(path, value);
  }

  private transactionPath(id: string): string { return join(this.transactionsDir, `${safeWorkStreamClaimId(id)}.json`); }
  private blockerPath(id: string): string { return join(this.blockersDir, `${safeWorkStreamClaimId(id)}.json`); }
  private evidencePath(id: string): string { return join(this.evidenceDir, `${safeWorkStreamClaimId(id)}.json`); }
  private claimReceiptPath(id: string): string { return join(this.claimReceiptsDir, `${safeWorkStreamClaimId(id)}.json`); }
}

function blockerTransactionId(contractId: string, workstreamId: string, blockerId: string, generation: number): string {
  const digest = createHash("sha256").update(`${contractId}\n${workstreamId}\n${blockerId}\n${generation}`).digest("hex").slice(0, 24);
  return `blocker-tx-${digest}`;
}
