import type { PublicWorkObligationKind } from "../../tool-support/index.ts";

export const EVIDENCE_CAPABILITY_SCHEMA_VERSION = "evidence-capability.v1" as const;

export const EVIDENCE_CAPABILITY_TAXONOMY = {
  candidateDiscovery: "source_candidate",
  sourceVerification: "source_verified",
  execution: "command_executed",
  mutation: "workspace_mutated",
  artifact: "durable_artifact",
  dataTable: "data_table_created",
  chart: "chart_rendered",
  validation: "validation_passed",
  browserObservation: "browser_observed",
  review: "review_completed",
  explicitBlocker: "explicit_blocker",
  limitation: "limitation_recorded",
} as const;

export const EVIDENCE_CAPABILITY_KINDS = Object.values(EVIDENCE_CAPABILITY_TAXONOMY);

export type EvidenceCapabilityKind = typeof EVIDENCE_CAPABILITY_KINDS[number];

export const EVIDENCE_CAPABILITY_EVIDENCE_KINDS = [
  "source_candidate",
  "source_page",
  "workspace_inspection",
  "execution_result",
  "mutation_result",
  "artifact",
  "data_table",
  "chart",
  "browser_observation",
  "review_result",
  "blocker",
  "limitation",
  "memory",
  "project_state",
] as const;

export type EvidenceCapabilityEvidenceKind = typeof EVIDENCE_CAPABILITY_EVIDENCE_KINDS[number];

export const EVIDENCE_CAPABILITY_MATURITIES = ["candidate", "verified", "rejected"] as const;

export type EvidenceCapabilityMaturity = typeof EVIDENCE_CAPABILITY_MATURITIES[number];

export const EVIDENCE_CAPABILITY_PRODUCER_KINDS = [
  "tool",
  "worker",
  "artifact",
  "memory",
  "project_ledger",
  "runtime",
  "external_source",
] as const;

export type EvidenceCapabilityProducerKind = typeof EVIDENCE_CAPABILITY_PRODUCER_KINDS[number];

export interface EvidenceCapabilityReference {
  label?: string;
  url?: string;
  path?: string;
  artifact_id?: string;
  tool_call_id?: string;
  task_id?: string;
}

export interface EvidenceCapabilityReceipt {
  receipt_id: string;
  schema_version: typeof EVIDENCE_CAPABILITY_SCHEMA_VERSION;
  producer: {
    kind: EvidenceCapabilityProducerKind;
    name: string;
    call_id?: string;
  };
  capability: EvidenceCapabilityKind;
  evidence_kind: EvidenceCapabilityEvidenceKind;
  maturity: EvidenceCapabilityMaturity;
  confidence: number;
  verified: boolean;
  summary: string;
  scope?: Record<string, unknown>;
  references: EvidenceCapabilityReference[];
  satisfies?: PublicWorkObligationKind[];
  limitations: string[];
  created_at: string;
}

export interface EvidenceCapabilityReceiptInput {
  producer: EvidenceCapabilityReceipt["producer"];
  capability: EvidenceCapabilityKind;
  evidence_kind: EvidenceCapabilityEvidenceKind;
  maturity?: EvidenceCapabilityMaturity;
  confidence?: number;
  verified?: boolean;
  summary: string;
  scope?: Record<string, unknown>;
  references?: EvidenceCapabilityReference[];
  satisfies?: PublicWorkObligationKind[];
  limitations?: string[];
  created_at?: string;
}

export interface EvidenceCapabilityReceiptIssue {
  field: string;
  code: string;
  message: string;
}

export type EvidenceCapabilityParseResult =
  | { ok: true; receipt: EvidenceCapabilityReceipt; issues: [] }
  | { ok: false; receipt: null; issues: EvidenceCapabilityReceiptIssue[] };

export interface RejectedEvidenceCapabilityReceipt {
  receipt_id?: string;
  schema_version?: string;
  issues: EvidenceCapabilityReceiptIssue[];
}

export interface EvidenceCapabilityLedger {
  required: PublicWorkObligationKind[];
  satisfied: PublicWorkObligationKind[];
  missing: PublicWorkObligationKind[];
  receipts: EvidenceCapabilityReceipt[];
  rejectedReceipts: RejectedEvidenceCapabilityReceipt[];
}
