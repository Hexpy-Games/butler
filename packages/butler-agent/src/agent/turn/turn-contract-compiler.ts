import { createHash } from "crypto";
import {
  COMPILED_TURN_CONTRACT_SCHEMA,
  TURN_CONTRACT_ACTIONS,
  TURN_CONTRACT_DECISION_SCHEMA,
  TURN_DELIVERABLES,
  type CompiledTurnContract,
  type EvidenceObligationSeed,
  type RequiredEvidenceObligation,
  type TurnContractAction,
  type TurnContractCandidates,
  type TurnContractDecision,
  type TurnContractWorkstreamCandidate,
  type TurnDeliverable,
  type TurnEvidenceClass,
  type TurnEvidenceProducer,
} from "./turn-contract-types.ts";

const EXECUTION_DELIVERABLES = new Set<TurnDeliverable>([
  "ledger_spec", "ledger_work", "ledger_tasks", "code_change", "validation", "review",
]);
type NormalizedEvidenceSeed = Omit<RequiredEvidenceObligation, "obligation_id">;

export const TURN_ACTION_DELIVERABLE_MATRIX: Record<TurnContractAction, {
  allowed: readonly TurnDeliverable[];
  required: readonly TurnDeliverable[];
  requiresDurableExecution: boolean;
}> = {
  answer: { allowed: [], required: [], requiresDurableExecution: false },
  inspect: { allowed: ["status_report"], required: ["status_report"], requiresDurableExecution: false },
  start_work: { allowed: TURN_DELIVERABLES, required: [], requiresDurableExecution: true },
  resume_work: { allowed: TURN_DELIVERABLES, required: [], requiresDurableExecution: true },
  modify_work: { allowed: TURN_DELIVERABLES, required: [], requiresDurableExecution: true },
  cancel_work: { allowed: [], required: [], requiresDurableExecution: false },
  supply_user_action: { allowed: TURN_DELIVERABLES, required: [], requiresDurableExecution: false },
};

export function compileTurnContract(input: {
  decision: TurnContractDecision;
  candidates?: TurnContractCandidates;
  obligationRequirements?: Partial<Record<TurnDeliverable, EvidenceObligationSeed>>;
  now?: Date;
}): CompiledTurnContract {
  const selected = validateTurnContractDecision(input.decision, input.candidates);
  const seeds = effectiveObligationSeeds(input.decision, selected, input.obligationRequirements);
  assertExecutionObligations(input.decision.action, seeds);
  const contractId = deterministicContractId(input.decision.decision_id);
  const decisionSemanticFingerprint = semanticDecisionFingerprint(input.decision, seeds);
  const requiredEvidence = seeds.map((seed, index) => obligation(contractId, seed, index));
  const deliverables = uniqueDeliverables(requiredEvidence.map((item) => item.deliverable));
  const now = (input.now ?? new Date()).toISOString();
  const trackingMode = deliverables.some((value) => value.startsWith("ledger_")) ||
      (input.decision.action === "inspect" && Boolean(input.decision.target_project_id))
    ? "ledger"
    : deliverables.some((value) => EXECUTION_DELIVERABLES.has(value)) ? "local" : "none";
  return {
    schema_version: COMPILED_TURN_CONTRACT_SCHEMA,
    contract_id: contractId,
    decision_id: input.decision.decision_id,
    decision_semantic_fingerprint: decisionSemanticFingerprint,
    action: input.decision.action,
    ...(input.decision.target_workstream_id ? { target_workstream_id: input.decision.target_workstream_id } : {}),
    ...(input.decision.target_project_id ? { target_project_id: input.decision.target_project_id } : {}),
    ...(input.decision.blocker_id ? { blocker_id: input.decision.blocker_id } : {}),
    deliverables,
    required_evidence: requiredEvidence,
    tracking_mode: trackingMode,
    closeout_strategy: input.decision.action === "inspect"
      ? "noop"
      : trackingMode === "ledger" ? "ledger" : trackingMode === "local" ? "local_workstream" : "noop",
    terminal_rule: input.decision.action === "answer" ? "answer" : input.decision.action === "inspect" ? "verified_report" : "deliverables_satisfied",
    state: input.decision.action === "answer" ? "satisfied" : "validated",
    generation: 1,
    evidence_receipt_ids: [],
    continuation_commit_ids: [],
    terminal_delivery_keys: [],
    created_at: now,
    updated_at: now,
  };
}

export function validateTurnContractDecision(
  decision: TurnContractDecision,
  candidates: TurnContractCandidates = {},
): TurnContractWorkstreamCandidate | null {
  if (decision.schema_version !== TURN_CONTRACT_DECISION_SCHEMA) throw new Error("turn_contract_invalid_schema");
  if (!safeText(decision.decision_id) || !safeText(decision.public_summary)) throw new Error("turn_contract_missing_identity");
  if (!TURN_CONTRACT_ACTIONS.includes(decision.action)) throw new Error("turn_contract_unknown_action");
  if (!Array.isArray(decision.deliverables) || new Set(decision.deliverables).size !== decision.deliverables.length) {
    throw new Error("turn_contract_duplicate_deliverables");
  }
  if (decision.deliverables.some((value) => !TURN_DELIVERABLES.includes(value))) throw new Error("turn_contract_unknown_deliverable");
  validateActionMatrix(decision);
  const selected = selectedCandidate(decision, candidates);
  if (decision.action === "answer") {
    if (!safeText(decision.answer_text)) throw new Error("turn_contract_invalid_answer");
  } else if (decision.answer_text !== undefined) {
    throw new Error("turn_contract_non_answer_has_answer_text");
  }
  if (decision.action === "supply_user_action") {
    if (selected?.state !== "waiting_user") throw new Error("turn_contract_supply_target_not_waiting");
    if (!safeText(decision.blocker_id) || decision.blocker_id !== selected.waiting_user_blocker_id) {
      throw new Error("turn_contract_supply_blocker_mismatch");
    }
  } else if (decision.blocker_id !== undefined) {
    throw new Error("turn_contract_unexpected_blocker_id");
  }
  if ((decision.action === "resume_work" || decision.action === "modify_work") && selected?.unsatisfied_obligations.length === 0) {
    throw new Error("turn_contract_target_has_no_unsatisfied_obligations");
  }
  return selected;
}

function validateActionMatrix(decision: TurnContractDecision): void {
  const matrix = TURN_ACTION_DELIVERABLE_MATRIX[decision.action];
  if (decision.deliverables.some((value) => !matrix.allowed.includes(value))) throw new Error("turn_contract_deliverable_not_allowed");
  if (matrix.required.some((value) => !decision.deliverables.includes(value))) throw new Error("turn_contract_required_deliverable_missing");
  if (matrix.requiresDurableExecution && !decision.deliverables.some((value) => EXECUTION_DELIVERABLES.has(value)) && decision.action === "start_work") {
    throw new Error("turn_contract_execution_requires_durable_deliverable");
  }
  if (decision.deliverables.includes("final_report") && !decision.deliverables.some((value) => EXECUTION_DELIVERABLES.has(value)) && decision.action === "start_work") {
    throw new Error("turn_contract_final_report_requires_durable_deliverable");
  }
}

function selectedCandidate(
  decision: TurnContractDecision,
  candidates: TurnContractCandidates,
): TurnContractWorkstreamCandidate | null {
  const requiresTarget = ["resume_work", "modify_work", "cancel_work", "supply_user_action"].includes(decision.action);
  if (!requiresTarget) return null;
  if (!safeText(decision.target_workstream_id)) throw new Error("turn_contract_missing_workstream_target");
  const selected = candidates.workstreams?.find((candidate) => candidate.workstream_id === decision.target_workstream_id);
  if (!selected) throw new Error("turn_contract_incompatible_workstream_target");
  return selected;
}

function effectiveObligationSeeds(
  decision: TurnContractDecision,
  selected: TurnContractWorkstreamCandidate | null,
  requirements: Partial<Record<TurnDeliverable, EvidenceObligationSeed>> = {},
): EvidenceObligationSeed[] {
  if (decision.action === "answer" || decision.action === "cancel_work") return [];
  const inherited = selected?.unsatisfied_obligations ?? [];
  const declared = decision.deliverables.map((deliverable) => requirements[deliverable] ?? defaultSeed(decision, deliverable));
  return dedupeSeeds([...inherited, ...declared]);
}

function defaultSeed(decision: TurnContractDecision, deliverable: TurnDeliverable): EvidenceObligationSeed {
  const targetKind = deliverable === "status_report" || deliverable.startsWith("ledger_")
    ? "project"
    : deliverable === "final_report" ? "report" : "workspace";
  return {
    deliverable,
    target_kind: targetKind,
    target_id: decision.target_project_id ?? decision.target_workstream_id ?? "active",
    generation: 1,
    cardinality: 1,
    expected_item_ids: [],
    ...defaultEvidencePolicy(deliverable),
  };
}

function assertExecutionObligations(action: TurnContractAction, seeds: EvidenceObligationSeed[]): void {
  if (!["start_work", "resume_work", "modify_work"].includes(action)) return;
  if (!seeds.some((seed) => EXECUTION_DELIVERABLES.has(seed.deliverable))) {
    throw new Error("turn_contract_execution_requires_durable_obligation");
  }
}

function obligation(contractId: string, seed: EvidenceObligationSeed, index: number): RequiredEvidenceObligation {
  const normalized = normalizeSeed(seed);
  return {
    ...normalized,
    obligation_id: `obligation-${hash(canonicalJson({ contractId, index, ...normalized })).slice(0, 24)}`,
  };
}

function deterministicContractId(decisionId: string): string {
  return `contract-${hash(decisionId).slice(0, 24)}`;
}

function semanticDecisionFingerprint(decision: TurnContractDecision, seeds: EvidenceObligationSeed[]): string {
  return hash(canonicalJson({
    decision_id: decision.decision_id,
    action: decision.action,
    target_workstream_id: decision.target_workstream_id,
    target_project_id: decision.target_project_id,
    blocker_id: decision.blocker_id,
    deliverables: decision.deliverables,
    answer_text: decision.answer_text,
    obligations: dedupeSeeds(seeds),
  }));
}

function dedupeSeeds(seeds: EvidenceObligationSeed[]): EvidenceObligationSeed[] {
  const result = new Map<string, EvidenceObligationSeed>();
  for (const seed of seeds) {
    const normalized = normalizeSeed(seed);
    result.set(canonicalJson(normalized), normalized);
  }
  return [...result.values()].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
}

function normalizeSeed(seed: EvidenceObligationSeed): NormalizedEvidenceSeed {
  const evidencePolicy = defaultEvidencePolicy(seed.deliverable);
  return {
    ...seed,
    cardinality: Math.max(1, Math.floor(seed.cardinality ?? 1)),
    expected_item_ids: [...new Set(seed.expected_item_ids ?? [])].sort(),
    evidence_class: seed.evidence_class ?? evidencePolicy.evidence_class,
    allowed_producers: [...new Set(seed.allowed_producers ?? evidencePolicy.allowed_producers)].sort(),
  };
}

function defaultEvidencePolicy(deliverable: TurnDeliverable): {
  evidence_class: TurnEvidenceClass;
  allowed_producers: TurnEvidenceProducer[];
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

function uniqueDeliverables(values: TurnDeliverable[]): TurnDeliverable[] {
  return TURN_DELIVERABLES.filter((value) => values.includes(value));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
