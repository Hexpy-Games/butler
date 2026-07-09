import type { BridgeToolAuditEvent } from "../../../tools/tool-bridge/audit.ts";
import type { EvidenceCapabilityReceipt } from "../../../output/evidence/types.ts";
import type { TurnObservation } from "../../turn-kernel.ts";

export type PublicWorkObligationKind =
  | "source_verified"
  | "command_executed"
  | "durable_artifact"
  | "data_table_created"
  | "chart_rendered";

export type OutcomeRequirementKind =
  | "source_coverage"
  | "structured_comparison"
  | "durable_deliverable"
  | "execution_result"
  | "state_inspection"
  | "custom";

export interface OutcomeRequirement {
  id: string;
  kind: OutcomeRequirementKind;
  description: string;
  required: boolean;
  coverageTarget?: number;
  properties?: Record<string, unknown>;
}

export interface OutcomeDeliverable {
  id: string;
  role: string;
  required: boolean;
  acceptableMediaTypes?: string[];
  requiredProperties?: string[];
}

export interface OutcomeContract {
  schema: "butler.outcome-contract.v1";
  id: string;
  objective: string;
  requirements: OutcomeRequirement[];
  deliverables: OutcomeDeliverable[];
  reporting: {
    userVisibleSummaryRequired: boolean;
    citeSourcesWhenAvailable: boolean;
  };
}

export type EvidenceReceiptProducerKind =
  | "tool"
  | "worker"
  | "artifact"
  | "memory"
  | "project_ledger"
  | "external_source"
  | "browser"
  | "app"
  | "review"
  | "runtime"
  | "provider"
  | "user";

export type EvidenceReceiptType =
  | "source"
  | "deliverable"
  | "execution"
  | "state"
  | "coverage"
  | "test"
  | "file_edit"
  | "artifact"
  | "browser_observation"
  | "app_observation"
  | "project_ledger_operation"
  | "review"
  | "pull_request"
  | "release"
  | "route_verification"
  | "user_decision_required"
  | "runtime_fault"
  | "provider_fault"
  | "cancellation"
  | "not_required";

export interface EvidenceReference {
  kind:
    | "url"
    | "artifact"
    | "tool_output"
    | "task"
    | "worker"
    | "project_document"
    | "memory"
    | "transcript_slice";
  ref: string;
  label?: string;
}

export interface EvidenceArtifactRef {
  id?: string;
  label?: string;
  path?: string;
  mediaType?: string;
  role?: string;
}

export interface EvidenceReceipt {
  schema: "butler.evidence-receipt.v1";
  id: string;
  producer: {
    kind: EvidenceReceiptProducerKind;
    name: string;
  };
  receiptType: EvidenceReceiptType;
  verified: boolean;
  covers: string[];
  summary: string;
  references: EvidenceReference[];
  artifacts?: EvidenceArtifactRef[];
  metrics?: Record<string, number>;
  satisfies?: PublicWorkObligationKind[];
}

export interface PublicWorkDecision {
  decisionId: string;
  workBlockId?: string;
  summary: string;
  rationale?: string;
  evidenceRefs: string[];
  nextStep?: string;
  completionObligations?: PublicWorkObligationKind[];
  source: "assistant-authored" | "model-authored" | "principal-authored" | "runtime-derived" | "review-repaired";
  toolName?: string;
  toolCallIndex?: number;
  claimed?: boolean;
  usageCount?: number;
  usageGroupId?: string;
  providerRound?: number;
}

export interface ToolAuditEntry {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  result?: unknown;
  error?: string;
  observation?: Pick<
    TurnObservation,
    | "kind"
    | "visibility"
    | "summary"
    | "modelVisibleContent"
    | "publicSummary"
    | "refs"
    | "causedByToolCallId"
    | "causedByDecisionId"
  >;
  publicDecision?: PublicWorkDecision;
  satisfiedCompletionObligations?: PublicWorkObligationKind[];
  evidenceReceipts?: EvidenceReceipt[];
  evidenceCapabilityReceipts?: EvidenceCapabilityReceipt[];
  bridgeAudit?: BridgeToolAuditEvent;
}

export interface ToolProgressSummary {
  kind: "searched" | "read" | "ran_command" | "edited" | "dispatch" | "used_tool" | "context" | "model";
  toolName: string;
  safeLabel: string;
  workBlockLabel: string;
  inputLabel: string;
  detailRows: Array<{
    id: string;
    kind: string;
    safe_label: string;
    safe_value?: string;
    state: string;
  }>;
}
