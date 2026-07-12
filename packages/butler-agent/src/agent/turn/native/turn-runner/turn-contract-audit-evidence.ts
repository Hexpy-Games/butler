import { createHash } from "crypto";
import {
  allEvidenceObligationsSatisfied,
  evidenceObligationSatisfied,
  TURN_EVIDENCE_RECEIPT_SCHEMA,
  TurnContractStore,
  type CompiledTurnContract,
  type RequiredEvidenceObligation,
  type TurnEvidenceProducer,
  type TurnEvidenceReceipt,
} from "../../turn-contract.ts";
import type { EvidenceCapabilityReceipt } from "../../../output/evidence/types.ts";
import type { ToolAuditEntry } from "../output/tool-types.ts";
import { recordTurnContractMetric } from "./turn-contract-metrics.ts";
import { isStatusReportEvidenceTool } from "./turn-contract-status-evidence.ts";

export function recordTurnContractAuditEvidence(input: {
  butlerData: string;
  contract: CompiledTurnContract;
  audit: readonly ToolAuditEntry[];
  finalCandidate: string;
  runtimeReviewCompleted?: boolean;
  planClosureSatisfied?: boolean;
}): CompiledTurnContract {
  const store = new TurnContractStore(input.butlerData);
  let contract = store.read(input.contract.contract_id) ?? input.contract;
  for (const obligation of contract.required_evidence) {
    const existing = store.evidenceFor(contract);
    if (evidenceObligationSatisfied({ contract, obligation, receipts: existing })) continue;
    for (const receipt of receiptsForObligation({ ...input, contract, obligation })) {
      contract = store.recordEvidence(receipt);
      if (evidenceObligationSatisfied({ contract, obligation, receipts: store.evidenceFor(contract) })) break;
    }
  }
  const runtimeReview = contract.required_evidence.find((item) => item.deliverable === "review");
  if (
    runtimeReview && input.runtimeReviewCompleted === true &&
    !evidenceObligationSatisfied({ contract, obligation: runtimeReview, receipts: store.evidenceFor(contract) })
  ) {
    contract = store.recordEvidence(receiptFor({
      contract,
      obligation: runtimeReview,
      producer: "review",
      sourceId: `runtime-review:${hash(input.finalCandidate).slice(0, 16)}`,
      itemIds: [],
    }));
  }
  if (
    input.finalCandidate.trim() &&
    input.planClosureSatisfied !== false &&
    nonReportObligationsSatisfied(contract, store.evidenceFor(contract))
  ) {
    for (const finalReport of contract.required_evidence.filter((item) =>
      item.deliverable === "final_report")) {
      if (evidenceObligationSatisfied({
        contract,
        obligation: finalReport,
        receipts: store.evidenceFor(contract),
      })) continue;
      contract = store.recordEvidence(receiptFor({
        contract,
        obligation: finalReport,
        producer: "runtime",
        sourceId: `final:${hash(input.finalCandidate).slice(0, 16)}`,
        itemIds: [],
      }));
    }
  }
  const recorded = store.read(contract.contract_id) ?? contract;
  recordTurnContractMetric({
    butlerData: input.butlerData,
    name: "evidence",
    status: "ok",
    contract: recorded,
  });
  return recorded;
}

export function unsatisfiedTurnContractObligations(input: {
  butlerData: string;
  contract: CompiledTurnContract;
}): RequiredEvidenceObligation[] {
  const store = new TurnContractStore(input.butlerData);
  const contract = store.read(input.contract.contract_id) ?? input.contract;
  const receipts = store.evidenceFor(contract);
  return contract.required_evidence.filter((obligation) =>
    !evidenceObligationSatisfied({ contract, obligation, receipts }));
}

function receiptsForObligation(input: {
  contract: CompiledTurnContract;
  obligation: RequiredEvidenceObligation;
  audit: readonly ToolAuditEntry[];
}): TurnEvidenceReceipt[] {
  return input.audit.flatMap((entry, index) => {
    if (!entry.ok || !auditMatchesObligation(entry, input.obligation, input.contract)) return [];
    const producer = producerFor(input.obligation);
    const itemIds = evidenceItemIds(entry, input.obligation);
    return [receiptFor({
      contract: input.contract,
      obligation: input.obligation,
      producer,
      sourceId: auditSourceId(entry, index),
      itemIds,
    })];
  });
}

function auditMatchesObligation(
  entry: ToolAuditEntry,
  obligation: RequiredEvidenceObligation,
  contract: CompiledTurnContract,
): boolean {
  const capabilities = entry.evidenceCapabilityReceipts ?? [];
  switch (obligation.deliverable) {
    case "grounded_answer":
      return false;
    case "status_report":
      return isStatusReportEvidenceTool(entry.name) || capabilities.some((receipt) =>
        verifiedCapability(receipt, ["source_verified"], ["project_state", "workspace_inspection"]));
    case "ledger_spec":
      return ledgerMutationMatches(entry, "spec");
    case "ledger_work":
      return ledgerMutationMatches(entry, "work") || canonicalResumeWorkRecordMatches(entry, contract);
    case "ledger_tasks":
      return ledgerMutationMatches(entry, "task");
    case "code_change":
      return entry.name === "write_file" || capabilities.some((receipt) =>
        executionCapabilityAllowed(receipt, contract) &&
        verifiedCapability(receipt, ["workspace_mutated", "durable_artifact"], ["mutation_result", "artifact"]));
    case "validation":
      return capabilities.some((receipt) =>
        executionCapabilityAllowed(receipt, contract) &&
        verifiedCapability(receipt, ["validation_passed"], ["execution_result"]));
    case "review":
      return entry.name === "review_planned_task" || capabilities.some((receipt) =>
        executionCapabilityAllowed(receipt, contract) &&
        verifiedCapability(receipt, ["review_completed"], ["review_result"]));
    case "final_report":
      return false;
  }
}

function executionCapabilityAllowed(
  receipt: EvidenceCapabilityReceipt,
  contract: CompiledTurnContract,
): boolean {
  return receipt.producer.kind !== "project_ledger" || (
    contract.action === "resume_work" && receipt.producer.name === "project_ledger_show"
  );
}

function canonicalResumeWorkRecordMatches(
  entry: ToolAuditEntry,
  contract: CompiledTurnContract,
): boolean {
  if (contract.action !== "resume_work" || entry.name !== "project_ledger_show") return false;
  return (entry.evidenceCapabilityReceipts ?? []).some((receipt) =>
    receipt.producer.kind === "project_ledger" &&
    verifiedCapability(receipt, ["source_verified"], ["project_state"]) &&
    recordScopeKind(receipt) === "work");
}

function recordScopeKind(receipt: EvidenceCapabilityReceipt): string | null {
  const scope = receipt.scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return null;
  return typeof scope.record_kind === "string" ? scope.record_kind : null;
}

function ledgerMutationMatches(entry: ToolAuditEntry, kind: "spec" | "work" | "task"): boolean {
  if (!new Set([
    "project_ledger_create", "project_ledger_update", "project_ledger_work_update",
    "project_ledger_work_complete", "project_ledger_task_update", "project_ledger_task_complete",
  ]).has(entry.name)) return false;
  if (entry.name.includes("work_")) return kind === "work";
  if (entry.name.includes("task_")) return kind === "task";
  return entry.args.kind === kind;
}

function evidenceItemIds(entry: ToolAuditEntry, obligation: RequiredEvidenceObligation): string[] {
  const id = typeof entry.args.id === "string" ? entry.args.id.trim() : "";
  if (id) return [id];
  return obligation.expected_item_ids.length === 0 ? [] : obligation.expected_item_ids.slice(0, 1);
}

function verifiedCapability(
  receipt: EvidenceCapabilityReceipt,
  capabilities: string[],
  evidenceKinds: string[],
): boolean {
  return receipt.verified === true && receipt.maturity === "verified" &&
    capabilities.includes(receipt.capability) && evidenceKinds.includes(receipt.evidence_kind);
}

function producerFor(obligation: RequiredEvidenceObligation): TurnEvidenceProducer {
  if (obligation.allowed_producers.includes("public_web")) return "public_web";
  if (obligation.allowed_producers.includes("project_ledger")) return "project_ledger";
  if (obligation.allowed_producers.includes("workspace")) return "workspace";
  if (obligation.allowed_producers.includes("validation")) return "validation";
  if (obligation.allowed_producers.includes("review")) return "review";
  return "runtime";
}

function receiptFor(input: {
  contract: CompiledTurnContract;
  obligation: RequiredEvidenceObligation;
  producer: TurnEvidenceProducer;
  sourceId: string;
  itemIds: string[];
}): TurnEvidenceReceipt {
  return {
    schema_version: TURN_EVIDENCE_RECEIPT_SCHEMA,
    receipt_id: `turn-evidence-${hash(`${input.contract.contract_id}\n${input.obligation.obligation_id}\n${input.sourceId}`).slice(0, 24)}`,
    contract_id: input.contract.contract_id,
    obligation_id: input.obligation.obligation_id,
    deliverable: input.obligation.deliverable,
    target_kind: input.obligation.target_kind,
    target_id: input.obligation.target_id,
    obligation_generation: input.obligation.generation,
    verified: true,
    item_ids: [...new Set(input.itemIds)].sort(),
    producer: input.producer,
    evidence_class: input.obligation.evidence_class,
    created_at: new Date().toISOString(),
  };
}

function nonReportObligationsSatisfied(contract: CompiledTurnContract, receipts: TurnEvidenceReceipt[]): boolean {
  const withoutReport = {
    ...contract,
    required_evidence: contract.required_evidence.filter((item) => item.deliverable !== "final_report"),
  };
  return allEvidenceObligationsSatisfied({ contract: withoutReport, receipts });
}

function auditSourceId(entry: ToolAuditEntry, index: number): string {
  const capabilityIds = (entry.evidenceCapabilityReceipts ?? []).map((item) => item.receipt_id).sort();
  return `${index}:${entry.name}:${capabilityIds.join(",")}:${hash(JSON.stringify(entry.args)).slice(0, 12)}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
