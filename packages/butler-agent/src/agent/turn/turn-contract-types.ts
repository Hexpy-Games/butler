export const TURN_CONTRACT_DECISION_SCHEMA = "butler.turn-contract-decision.v1" as const;
export const COMPILED_TURN_CONTRACT_SCHEMA = "butler.compiled-turn-contract.v1" as const;
export const TURN_EVIDENCE_RECEIPT_SCHEMA = "butler.turn-evidence-receipt.v1" as const;
export const TYPED_BLOCKER_SCHEMA = "butler.typed-blocker.v1" as const;
export const BLOCKER_EVIDENCE_RECEIPT_SCHEMA = "butler.blocker-evidence-receipt.v1" as const;

export const TURN_CONTRACT_ACTIONS = [
  "answer", "tool_answer", "inspect", "start_work", "resume_work", "modify_work", "cancel_work", "supply_user_action",
] as const;
export type TurnContractAction = typeof TURN_CONTRACT_ACTIONS[number];

export const CONTINUITY_SCOPES = ["project", "session", "global"] as const;
export type ContinuityScope = typeof CONTINUITY_SCOPES[number];

export const CONTINUITY_KINDS = [
  "instruction", "decision", "constraint", "working_state", "preference", "correction",
] as const;
export type ContinuityKind = typeof CONTINUITY_KINDS[number];

export const CONTINUITY_OPERATIONS = ["upsert", "supersede", "forget"] as const;
export type ContinuityOperation = typeof CONTINUITY_OPERATIONS[number];

export interface ContinuityUpdate {
  scope: ContinuityScope;
  kind: ContinuityKind;
  operation: ContinuityOperation;
  summary: string;
  target_ref?: string;
}

export const TURN_DELIVERABLES = [
  "grounded_answer", "status_report", "ledger_spec", "ledger_work", "ledger_tasks", "code_change", "validation", "review", "final_report",
] as const;
export type TurnDeliverable = typeof TURN_DELIVERABLES[number];

export type TurnEvidenceProducer = "runtime" | "public_web" | "project_ledger" | "workspace" | "validation" | "review";
export type TurnEvidenceClass =
  | "grounded_answer"
  | "status_snapshot"
  | "canonical_record"
  | "canonical_task_set"
  | "durable_diff"
  | "passing_validation"
  | "review_result"
  | "final_report";

export const USER_BLOCKER_CODES = [
  "authentication_required",
  "destructive_confirmation_required",
  "captcha_required",
  "payment_required",
  "product_choice_required",
] as const;
export type UserBlockerCode = typeof USER_BLOCKER_CODES[number];

export interface TurnContractDecision {
  schema_version: typeof TURN_CONTRACT_DECISION_SCHEMA;
  decision_id: string;
  action: TurnContractAction;
  target_workstream_id?: string;
  target_project_id?: string;
  blocker_id?: string;
  evidence_domain?: "public_web";
  inspection_scope?: "project" | "workspace";
  deliverables: TurnDeliverable[];
  continuity_updates?: ContinuityUpdate[];
  answer_text?: string;
  public_title?: string;
  public_summary: string;
  public_rationale?: string;
  immediate_next_step?: string;
}

export interface EvidenceObligationSeed {
  deliverable: TurnDeliverable;
  target_kind: "public" | "project" | "workstream" | "workspace" | "report";
  target_id: string;
  generation: number;
  cardinality?: number;
  expected_item_ids?: string[];
  evidence_class?: TurnEvidenceClass;
  allowed_producers?: TurnEvidenceProducer[];
}

export interface RequiredEvidenceObligation extends EvidenceObligationSeed {
  obligation_id: string;
  cardinality: number;
  expected_item_ids: string[];
  evidence_class: TurnEvidenceClass;
  allowed_producers: TurnEvidenceProducer[];
}

export interface TurnContractWorkstreamCandidate {
  workstream_id: string;
  state: string;
  unsatisfied_obligations: EvidenceObligationSeed[];
  tracking_mode?: CompiledTurnContract["tracking_mode"];
  waiting_user_blocker_id?: string;
}

export interface TurnContractCandidates {
  workstreams?: readonly TurnContractWorkstreamCandidate[];
}

export interface CompiledTurnContract {
  schema_version: typeof COMPILED_TURN_CONTRACT_SCHEMA;
  contract_id: string;
  decision_id: string;
  decision_semantic_fingerprint: string;
  action: TurnContractAction;
  target_workstream_id?: string;
  target_project_id?: string;
  blocker_id?: string;
  evidence_domain?: "public_web";
  inspection_scope?: "project" | "workspace";
  deliverables: TurnDeliverable[];
  required_evidence: RequiredEvidenceObligation[];
  tracking_mode: "ledger" | "local" | "none";
  closeout_strategy: "ledger" | "local_workstream" | "noop";
  terminal_rule: "answer" | "grounded_answer" | "verified_report" | "deliverables_satisfied";
  state: "validated" | "claimed" | "executing" | "reviewing" | "waiting_user" | "continuing" | "satisfied" | "delivered" | "cancelled" | "failed_system";
  generation: number;
  evidence_receipt_ids: string[];
  continuation_commit_ids: string[];
  terminal_delivery_keys: string[];
  cancellation_receipt_id?: string;
  created_at: string;
  updated_at: string;
}

export interface TurnEvidenceReceipt {
  schema_version: typeof TURN_EVIDENCE_RECEIPT_SCHEMA;
  receipt_id: string;
  contract_id: string;
  obligation_id: string;
  deliverable: TurnDeliverable;
  target_kind: RequiredEvidenceObligation["target_kind"];
  target_id: string;
  obligation_generation: number;
  verified: boolean;
  item_ids: string[];
  producer: TurnEvidenceProducer;
  evidence_class: TurnEvidenceClass;
  created_at: string;
}

export interface TurnCancellationReceipt {
  schema_version: "butler.workstream-claim-receipt.v1";
  receipt_id: string;
  operation: "cancel";
  outcome: "cancelled";
  workstream_id: string;
  project_id?: string;
  contract_id: string;
  released_contract_id: string;
  before_generation: number;
  after_generation: number;
}

export interface TypedBlocker {
  schema_version: typeof TYPED_BLOCKER_SCHEMA;
  blocker_id: string;
  owner: "user" | "external" | "system";
  code: UserBlockerCode | string;
  evidence_ref: string;
  requested_action?: string;
  retry_policy?: string;
}

export interface BlockerEvidenceReceipt {
  schema_version: typeof BLOCKER_EVIDENCE_RECEIPT_SCHEMA;
  receipt_id: string;
  producer: "runtime";
  contract_id: string;
  workstream_id: string;
  blocker_id: string;
  owner: "user";
  code: UserBlockerCode;
  requested_action: string;
  verified: boolean;
  created_at: string;
}
