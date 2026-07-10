import { createHash } from "crypto";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { readJsonFile, withDurableFileLock, writeJsonFileAtomic } from "../persistence/atomic-json-store.ts";
import { allEvidenceObligationsSatisfied, assertEvidenceReceiptForContract } from "./turn-contract-evidence.ts";
import {
  COMPILED_TURN_CONTRACT_SCHEMA,
  type CompiledTurnContract,
  type TurnCancellationReceipt,
  type TurnEvidenceReceipt,
} from "./turn-contract-types.ts";

type DurableCancellationReceipt = TurnCancellationReceipt;

export class TurnContractStore {
  readonly contractsDir: string;
  readonly receiptsDir: string;
  readonly decisionsDir: string;

  constructor(readonly butlerData: string) {
    this.contractsDir = join(butlerData, "turn-contracts");
    this.receiptsDir = join(this.contractsDir, "evidence-receipts");
    this.decisionsDir = join(this.contractsDir, "decisions");
  }

  read(contractId: string): CompiledTurnContract | null {
    const record = readJsonFile<CompiledTurnContract>(this.contractPath(contractId));
    return record ? normalizeContract(record) : null;
  }

  create(contract: CompiledTurnContract): CompiledTurnContract {
    const result = withDurableFileLock({
      lockPath: `${this.decisionPath(contract.decision_id)}.lock`,
      lockRoot: this.butlerData,
      ownerId: `create:${contract.decision_id}`,
      action: () => {
        const decision = readJsonFile<DecisionIdentityRecord>(this.decisionPath(contract.decision_id));
        if (decision && decision.semantic_fingerprint !== contract.decision_semantic_fingerprint) {
          throw new Error("turn_contract_decision_conflict");
        }
        const existing = this.read(decision?.contract_id ?? contract.contract_id);
        if (existing) {
          if (
            existing.decision_id !== contract.decision_id ||
            existing.decision_semantic_fingerprint !== contract.decision_semantic_fingerprint ||
            immutableContractFingerprint(existing) !== immutableContractFingerprint(contract)
          ) {
            throw new Error("turn_contract_decision_conflict");
          }
          if (!decision) writeJsonFileAtomic(this.decisionPath(contract.decision_id), decisionRecord(contract));
          return existing;
        }
        writeJsonFileAtomic(this.contractPath(contract.contract_id), contract);
        writeJsonFileAtomic(this.decisionPath(contract.decision_id), decisionRecord(contract));
        return contract;
      },
    });
    if (!result) throw new Error("turn_contract_store_conflict");
    return result;
  }

  recordEvidence(receipt: TurnEvidenceReceipt, now = new Date()): CompiledTurnContract {
    const result = withDurableFileLock({
      lockPath: `${this.contractPath(receipt.contract_id)}.lock`,
      lockRoot: this.butlerData,
      ownerId: `evidence:${receipt.receipt_id}`,
      now,
      action: () => {
        const contract = this.read(receipt.contract_id);
        if (!contract) throw new Error("turn_contract_not_found");
        assertEvidenceReceiptForContract(contract, receipt);
        const existingReceipt = this.readEvidence(receipt.receipt_id);
        if (existingReceipt && JSON.stringify(existingReceipt) !== JSON.stringify(receipt)) {
          throw new Error("turn_contract_evidence_identity_conflict");
        }
        if (!existingReceipt) writeJsonFileAtomic(this.receiptPath(receipt.receipt_id), receipt);
        if (contract.evidence_receipt_ids.includes(receipt.receipt_id)) return contract;
        const candidate: CompiledTurnContract = {
          ...contract,
          evidence_receipt_ids: [...contract.evidence_receipt_ids, receipt.receipt_id].sort(),
          generation: contract.generation + 1,
          updated_at: now.toISOString(),
        };
        const updated: CompiledTurnContract = allEvidenceObligationsSatisfied({
          contract: candidate,
          receipts: this.evidenceFor(candidate),
        })
          ? { ...candidate, state: "satisfied" }
          : candidate;
        writeJsonFileAtomic(this.contractPath(contract.contract_id), updated);
        return updated;
      },
    });
    if (!result) throw new Error("turn_contract_store_conflict");
    return result;
  }

  readEvidence(receiptId: string): TurnEvidenceReceipt | null {
    return readJsonFile<TurnEvidenceReceipt>(this.receiptPath(receiptId));
  }

  transitionState(input: {
    contractId: string;
    state: CompiledTurnContract["state"];
    expectedGeneration: number;
    now?: Date;
  }): CompiledTurnContract {
    const now = input.now ?? new Date();
    const result = withDurableFileLock({
      lockPath: `${this.contractPath(input.contractId)}.lock`,
      lockRoot: this.butlerData,
      ownerId: `state:${input.contractId}:${input.state}`,
      now,
      action: () => {
        const contract = this.read(input.contractId);
        if (!contract) throw new Error("turn_contract_not_found");
        if (contract.state === input.state) return contract;
        if (terminalContractState(contract.state)) throw new Error("turn_contract_terminal_immutable");
        if (contract.generation !== input.expectedGeneration) throw new Error("turn_contract_generation_conflict");
        if (input.state === "continuing") throw new Error("turn_contract_continuation_commit_required");
        if (!turnContractStateTransitionAllowed(contract.state, input.state)) {
          throw new Error(`turn_contract_state_transition_invalid:${contract.state}:${input.state}`);
        }
        const updated: CompiledTurnContract = {
          ...contract,
          state: input.state,
          generation: contract.generation + 1,
          updated_at: now.toISOString(),
        };
        writeJsonFileAtomic(this.contractPath(contract.contract_id), updated);
        return updated;
      },
    });
    if (!result) throw new Error("turn_contract_store_conflict");
    return result;
  }

  recordContinuationCommit(input: {
    contractId: string;
    commitId: string;
    expectedGeneration: number;
    now?: Date;
  }): CompiledTurnContract {
    const now = input.now ?? new Date();
    safeId(input.commitId);
    const result = withDurableFileLock({
      lockPath: `${this.contractPath(input.contractId)}.lock`,
      lockRoot: this.butlerData,
      ownerId: `continuation:${input.commitId}`,
      now,
      action: () => {
        const contract = this.read(input.contractId);
        if (!contract) throw new Error("turn_contract_not_found");
        if (contract.continuation_commit_ids.includes(input.commitId)) return contract;
        if (terminalContractState(contract.state)) throw new Error("turn_contract_terminal_immutable");
        if (contract.generation !== input.expectedGeneration) throw new Error("turn_contract_generation_conflict");
        if (!turnContractStateTransitionAllowed(contract.state, "continuing")) {
          throw new Error(`turn_contract_state_transition_invalid:${contract.state}:continuing`);
        }
        const updated: CompiledTurnContract = {
          ...contract,
          state: "continuing",
          continuation_commit_ids: [...contract.continuation_commit_ids, input.commitId].sort(),
          generation: contract.generation + 1,
          updated_at: now.toISOString(),
        };
        writeJsonFileAtomic(this.contractPath(contract.contract_id), updated);
        return updated;
      },
    });
    if (!result) throw new Error("turn_contract_store_conflict");
    return result;
  }

  evidenceFor(contract: CompiledTurnContract): TurnEvidenceReceipt[] {
    return contract.evidence_receipt_ids
      .map((id) => this.readEvidence(id))
      .filter((receipt): receipt is TurnEvidenceReceipt => Boolean(receipt));
  }

  recordCancellationReceipt(input: {
    contractId: string;
    receiptId: string;
    expectedGeneration: number;
    now?: Date;
  }): CompiledTurnContract {
    const now = input.now ?? new Date();
    const result = withDurableFileLock({
      lockPath: `${this.contractPath(input.contractId)}.lock`,
      lockRoot: this.butlerData,
      ownerId: `cancellation-receipt:${input.receiptId}`,
      now,
      action: () => {
        const contract = this.read(input.contractId);
        if (!contract) throw new Error("turn_contract_not_found");
        if (contract.action !== "cancel_work") throw new Error("turn_contract_cancellation_action_invalid");
        if (contract.cancellation_receipt_id === input.receiptId) return contract;
        if (terminalContractState(contract.state)) throw new Error("turn_contract_terminal_immutable");
        if (contract.generation !== input.expectedGeneration) throw new Error("turn_contract_generation_conflict");
        const receipt = readJsonFile<DurableCancellationReceipt>(this.cancellationReceiptPath(input.receiptId));
        const stream = contract.target_workstream_id
          ? readJsonFile<{ id: string; project_id?: string | null; state: string; active_claim_receipt_id?: string | null }>(this.workstreamPath(contract.target_workstream_id))
          : null;
        if (
          !receipt || receipt.schema_version !== "butler.workstream-claim-receipt.v1" || receipt.operation !== "cancel" ||
          receipt.outcome !== "cancelled" || receipt.contract_id !== contract.contract_id ||
          receipt.workstream_id !== contract.target_workstream_id || receipt.project_id !== contract.target_project_id ||
          receipt.after_generation !== receipt.before_generation + 1 || !receipt.released_contract_id ||
          !stream || stream.id !== receipt.workstream_id || stream.state !== "cancelled" || stream.active_claim_receipt_id !== receipt.receipt_id
        ) throw new Error("turn_contract_cancellation_receipt_invalid");
        const updated: CompiledTurnContract = {
          ...contract,
          cancellation_receipt_id: receipt.receipt_id,
          generation: contract.generation + 1,
          updated_at: now.toISOString(),
        };
        writeJsonFileAtomic(this.contractPath(contract.contract_id), updated);
        return updated;
      },
    });
    if (!result) throw new Error("turn_contract_store_conflict");
    return result;
  }

  recordTerminalDelivery(input: {
    contractId: string;
    terminalState: "delivered" | "cancelled" | "failed_system";
    expectedGeneration: number;
    now?: Date;
  }): { contract: CompiledTurnContract; replayed: boolean; deliveryKey: string } {
    const now = input.now ?? new Date();
    const deliveryKey = terminalDeliveryKey(input.contractId, input.terminalState);
    const result = withDurableFileLock({
      lockPath: `${this.contractPath(input.contractId)}.lock`,
      lockRoot: this.butlerData,
      ownerId: `delivery:${deliveryKey}`,
      now,
      action: () => {
        const contract = this.read(input.contractId);
        if (!contract) throw new Error("turn_contract_not_found");
        if (terminalContractState(contract.state)) {
          if (contract.state === input.terminalState && contract.terminal_delivery_keys.includes(deliveryKey)) {
            return { contract, replayed: true, deliveryKey };
          }
          throw new Error("turn_contract_terminal_immutable");
        }
        if (contract.terminal_delivery_keys.includes(deliveryKey)) {
          return { contract, replayed: true, deliveryKey };
        }
        if (contract.generation !== input.expectedGeneration) throw new Error("turn_contract_generation_conflict");
        if (input.terminalState === "cancelled" && (contract.action !== "cancel_work" || !contract.cancellation_receipt_id)) {
          throw new Error("turn_contract_cancellation_receipt_required");
        }
        if (
          input.terminalState === "delivered" &&
          contract.terminal_rule !== "answer" &&
          !allEvidenceObligationsSatisfied({ contract, receipts: this.evidenceFor(contract) })
        ) {
          throw new Error("turn_contract_delivery_evidence_incomplete");
        }
        const updated: CompiledTurnContract = {
          ...contract,
          state: input.terminalState,
          generation: contract.generation + 1,
          terminal_delivery_keys: [...contract.terminal_delivery_keys, deliveryKey],
          updated_at: now.toISOString(),
        };
        writeJsonFileAtomic(this.contractPath(contract.contract_id), updated);
        return { contract: updated, replayed: false, deliveryKey };
      },
    });
    if (!result) throw new Error("turn_contract_store_conflict");
    return result;
  }

  listNonTerminal(): CompiledTurnContract[] {
    if (!existsSync(this.contractsDir)) return [];
    return readdirSync(this.contractsDir)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => readJsonFile<CompiledTurnContract>(join(this.contractsDir, entry)))
      .filter((contract): contract is CompiledTurnContract => contract?.schema_version === COMPILED_TURN_CONTRACT_SCHEMA)
      .map(normalizeContract)
      .filter((contract) => !["delivered", "cancelled", "failed_system"].includes(contract.state));
  }

  private contractPath(contractId: string): string {
    return join(this.contractsDir, `${safeId(contractId)}.json`);
  }

  private receiptPath(receiptId: string): string {
    return join(this.receiptsDir, `${safeId(receiptId)}.json`);
  }

  private decisionPath(decisionId: string): string {
    return join(this.decisionsDir, `${safeId(decisionId)}.json`);
  }

  private cancellationReceiptPath(receiptId: string): string {
    return join(this.butlerData, "workstream-claim-receipts", `${safeId(receiptId)}.json`);
  }

  private workstreamPath(workstreamId: string): string {
    return join(this.butlerData, "work-streams", `${safeId(workstreamId)}.json`);
  }
}

interface DecisionIdentityRecord {
  schema_version: "butler.turn-contract-decision-identity.v1";
  decision_id: string;
  contract_id: string;
  semantic_fingerprint: string;
}

function decisionRecord(contract: CompiledTurnContract): DecisionIdentityRecord {
  return {
    schema_version: "butler.turn-contract-decision-identity.v1",
    decision_id: contract.decision_id,
    contract_id: contract.contract_id,
    semantic_fingerprint: contract.decision_semantic_fingerprint,
  };
}

function normalizeContract(contract: CompiledTurnContract): CompiledTurnContract {
  if (contract.schema_version !== COMPILED_TURN_CONTRACT_SCHEMA) throw new Error("turn_contract_invalid_persisted_schema");
  return {
    ...contract,
    required_evidence: normalizeObligations(contract),
    generation: contract.generation ?? 1,
    evidence_receipt_ids: contract.evidence_receipt_ids ?? [],
    continuation_commit_ids: contract.continuation_commit_ids ?? [],
    terminal_delivery_keys: contract.terminal_delivery_keys ?? [],
    decision_semantic_fingerprint: contract.decision_semantic_fingerprint ?? immutableContractFingerprint(contract),
  };
}

function normalizeObligations(contract: CompiledTurnContract): CompiledTurnContract["required_evidence"] {
  return (contract.required_evidence ?? []).map((obligation, index) => {
    if (obligation.obligation_id && obligation.target_kind && obligation.target_id) {
      return {
        ...obligation,
        cardinality: obligation.cardinality ?? 1,
        expected_item_ids: obligation.expected_item_ids ?? [],
        evidence_class: obligation.evidence_class ?? defaultEvidencePolicy(obligation.deliverable).evidence_class,
        allowed_producers: obligation.allowed_producers ?? defaultEvidencePolicy(obligation.deliverable).allowed_producers,
      };
    }
    const deliverable = obligation.deliverable;
    const targetKind = deliverable === "status_report" || deliverable.startsWith("ledger_")
      ? "project" as const
      : deliverable === "final_report" ? "report" as const : "workspace" as const;
    return {
      obligation_id: `legacy-obligation-${createHash("sha256").update(`${contract.contract_id}\n${deliverable}\n${index}`).digest("hex").slice(0, 20)}`,
      deliverable,
      target_kind: targetKind,
      target_id: contract.target_workstream_id ?? contract.target_project_id ?? "active",
      generation: 1,
      cardinality: 1,
      expected_item_ids: [],
      ...defaultEvidencePolicy(deliverable),
    };
  });
}

function defaultEvidencePolicy(deliverable: CompiledTurnContract["deliverables"][number]): {
  evidence_class: CompiledTurnContract["required_evidence"][number]["evidence_class"];
  allowed_producers: CompiledTurnContract["required_evidence"][number]["allowed_producers"];
} {
  switch (deliverable) {
    case "status_report": return { evidence_class: "status_snapshot", allowed_producers: ["runtime", "project_ledger"] };
    case "ledger_spec":
    case "ledger_work": return { evidence_class: "canonical_record", allowed_producers: ["project_ledger"] };
    case "ledger_tasks": return { evidence_class: "canonical_task_set", allowed_producers: ["project_ledger"] };
    case "code_change": return { evidence_class: "durable_diff", allowed_producers: ["workspace"] };
    case "validation": return { evidence_class: "passing_validation", allowed_producers: ["validation"] };
    case "review": return { evidence_class: "review_result", allowed_producers: ["review"] };
    case "final_report": return { evidence_class: "final_report", allowed_producers: ["runtime"] };
  }
}

function immutableContractFingerprint(contract: CompiledTurnContract): string {
  return JSON.stringify({
    contract_id: contract.contract_id,
    decision_id: contract.decision_id,
    action: contract.action,
    target_workstream_id: contract.target_workstream_id,
    target_project_id: contract.target_project_id,
    blocker_id: contract.blocker_id,
    deliverables: contract.deliverables,
    required_evidence: contract.required_evidence,
  });
}

function terminalDeliveryKey(contractId: string, state: string): string {
  return `delivery-${createHash("sha256").update(`${contractId}\n${state}`).digest("hex").slice(0, 24)}`;
}

function terminalContractState(state: CompiledTurnContract["state"]): boolean {
  return state === "delivered" || state === "cancelled" || state === "failed_system";
}

function turnContractStateTransitionAllowed(
  current: CompiledTurnContract["state"],
  next: CompiledTurnContract["state"],
): boolean {
  const transitions: Partial<Record<CompiledTurnContract["state"], readonly CompiledTurnContract["state"][]>> = {
    validated: ["claimed", "executing", "waiting_user", "continuing", "satisfied"],
    claimed: ["executing", "reviewing", "continuing", "satisfied"],
    executing: ["reviewing", "continuing", "satisfied"],
    reviewing: ["executing", "continuing", "satisfied"],
    waiting_user: ["claimed", "executing", "continuing"],
    continuing: ["executing", "reviewing", "satisfied"],
  };
  return transitions[current]?.includes(next) === true;
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) throw new Error("turn_contract_unsafe_id");
  return value;
}
