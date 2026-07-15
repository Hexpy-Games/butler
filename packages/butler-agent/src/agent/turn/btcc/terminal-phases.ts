import { createHash } from "node:crypto";
import type { PromptUsageSectionAttribution } from "../../../integrations/providers/provider.ts";
import type { ToolAuditEntry } from "../native/output/tool-types.ts";
import type { BtccNativePhaseCoordinator } from "./native-phase-coordinator.ts";

type PrivateTextPrompt = (
  prompt: string,
  phase: string,
  sections?: PromptUsageSectionAttribution[],
  responseFormat?: {
    type: "json_schema";
    name: string;
    strict: true;
    schema: Record<string, unknown>;
  },
) => Promise<string>;

export interface BtccFinalDossierV1 {
  schemaVersion: "butler.btcc-final-dossier.v1";
  outcome: "complete";
  goalCoverage: Array<{
    criterionId: string;
    status: "passed";
    evidenceRefs: string[];
  }>;
  deliveredItems: string[];
  limitations: string[];
  trackingCloseout: string;
  evidenceRefs: string[];
}

export async function runBtccConsolidation(input: {
  coordinator: BtccNativePhaseCoordinator;
  candidateText: string;
  audit: ToolAuditEntry[];
  runPrivateTextPrompt: PrivateTextPrompt;
}): Promise<{
  dossier: BtccFinalDossierV1;
  modelCallRef: string;
  evidenceRefs: string[];
}> {
  const state = input.coordinator.state();
  if (state.currentPhase !== "consolidation") {
    throw new Error("btcc_consolidation_phase_not_active");
  }
  if (!state.activeConsolidationTargetRef || !state.goalContractRef) {
    throw new Error("btcc_consolidation_authority_missing");
  }
  const evidenceRefs = unique([
    state.activeConsolidationTargetRef,
    state.goalContractRef,
    ...(state.planRevisionRef ? [state.planRevisionRef] : []),
    ...auditEvidenceRefs(input.audit),
  ]);
  const goalContract = input.coordinator.goalContract();
  const expectedCriterionIds = goalContract.acceptanceIntents.map((criterion) => criterion.key);
  const modelCallRef = `model-call:consolidation:${state.turnId}:${state.phaseGeneration}`;
  const prompt = [
    input.coordinator.prompt("task").text,
    "## Whole-goal Consolidation Capsule",
    JSON.stringify({
      goalContractRef: state.goalContractRef,
      goalContract,
      taskGraphRef: state.planRevisionRef,
      reviewCandidateRef: state.activeConsolidationTargetRef,
      candidateText: input.candidateText,
      evidenceRefs,
    }),
    "Return one complete FinalDossier. Do not rewrite a missing criterion as a limitation; an actual gap must be returned to its owning phase before this call.",
  ].join("\n\n");
  const raw = await input.runPrivateTextPrompt(
    prompt,
    "btcc_consolidation",
    sections("btcc_consolidation", prompt),
    consolidationResponseFormat(expectedCriterionIds),
  );
  return {
    dossier: parseDossier(raw, new Set(evidenceRefs), expectedCriterionIds),
    modelCallRef,
    evidenceRefs,
  };
}

export async function runBtccReporter(input: {
  coordinator: BtccNativePhaseCoordinator;
  priorCandidateText: string;
  guardFeedback?: BtccReportGuardGap;
  runPrivateTextPrompt: PrivateTextPrompt;
  reportIndex: number;
}): Promise<{
  text: string;
  reportingItemRefs: string[];
  evidenceRefs: string[];
  modelCallRef: string;
}> {
  const state = input.coordinator.state();
  if (state.currentPhase !== "reporting" || !state.activeFinalDossierRef) {
    throw new Error("btcc_reporting_dossier_missing");
  }
  const dossier = state.activeFinalDossierRef;
  const dossierPayload = input.coordinator.readArtifact(dossier)?.payload;
  if (!dossierPayload) throw new Error("btcc_reporting_dossier_missing");
  const finalDossier = dossierPayload as BtccFinalDossierV1;
  const reportingItemRefs = finalDossier.deliveredItems.map((item, index) =>
    `reporting-item:${createHash("sha256")
      .update(JSON.stringify({ dossier, index, item }))
      .digest("hex").slice(0, 24)}`);
  const evidenceRefs = unique(finalDossier.evidenceRefs);
  const modelCallRef = `model-call:reporter:${state.turnId}:${input.reportIndex}`;
  const prompt = [
    input.coordinator.prompt(input.reportIndex === 1 ? "task" : "resume").text,
    "## Reporting Capsule",
    JSON.stringify({
      finalDossierRef: dossier,
      finalDossier,
      requiredReportingItemRefs: reportingItemRefs,
      admittedEvidenceRefs: evidenceRefs,
      priorCandidateText: input.priorCandidateText,
      guardFeedback: input.guardFeedback ?? null,
    }),
    "Return one strict report candidate. report_text is the principal-facing answer; bind every required reporting item exactly once and cite only admitted evidence refs. Lead with the outcome, stay concise, and state evidence, validation/review, limitations, tracking closeout, and any user-owned next decision that materially matters.",
  ].join("\n\n");
  const raw = await input.runPrivateTextPrompt(
    prompt,
    "btcc_reporting_reporter",
    sections("btcc_reporting_reporter", prompt),
    reporterResponseFormat(reportingItemRefs, evidenceRefs),
  );
  const candidate = parseReporterCandidate(raw, reportingItemRefs, evidenceRefs);
  const text = candidate.text.trim();
  if (!text) throw new Error("btcc_report_candidate_empty");
  return { ...candidate, text, modelCallRef };
}

export interface BtccReportGuardPass {
  outcome: "passed";
  summary: string;
  criterionVerdicts: BtccReportCriterionVerdict[];
  modelCallRef: string;
}

export interface BtccReportGuardGap {
  outcome: "return_ticket";
  summary: string;
  requiredChange: string;
  reasonCode: string;
  gapFingerprint: string;
  criterionVerdicts: BtccReportCriterionVerdict[];
  modelCallRef: string;
}

const BTCC_REPORT_CRITERIA = [
  "factual_support",
  "requested_result_coverage",
  "safety",
  "clarity",
  "terminal_honesty",
  "tracking_closeout",
] as const;

type BtccReportCriterionId = (typeof BTCC_REPORT_CRITERIA)[number];

interface BtccReportCriterionVerdict {
  criterionId: BtccReportCriterionId;
  status: "passed" | "failed";
  findingCode: string | null;
  requiredChange: string | null;
}

export async function runBtccReportGuard(input: {
  coordinator: BtccNativePhaseCoordinator;
  reportText: string;
  runPrivateTextPrompt: PrivateTextPrompt;
  guardIndex: number;
}): Promise<BtccReportGuardPass | BtccReportGuardGap> {
  const state = input.coordinator.state();
  if (state.currentPhase !== "reporting") throw new Error("btcc_reporting_phase_not_active");
  const dossier = state.activeFinalDossierRef
    ? input.coordinator.readArtifact(state.activeFinalDossierRef)?.payload
    : null;
  if (!dossier) throw new Error("btcc_reporting_dossier_missing");
  const modelCallRef = `model-call:report-guard:${state.turnId}:${input.guardIndex}`;
  const prompt = [
    input.coordinator.prompt("task").text,
    "## ReportGuard Capsule",
    JSON.stringify({
      finalDossierRef: state.activeFinalDossierRef,
      finalDossier: dossier,
      reportText: input.reportText,
    }),
    `Independently return all six rubric criteria exactly once (${BTCC_REPORT_CRITERIA.join(", ")}). Return passed only when all pass; otherwise return the complete failed frontier and one precise ReturnTicket to Reporting. Do not rewrite the report.`,
  ].join("\n\n");
  const raw = await input.runPrivateTextPrompt(
    prompt,
    "btcc_reporting_guard",
    sections("btcc_reporting_guard", prompt),
    reportGuardResponseFormat(),
  );
  return parseReportGuard(raw, modelCallRef);
}

function consolidationResponseFormat(expectedCriterionIds: readonly string[]) {
  return {
    type: "json_schema" as const,
    name: "butler_btcc_final_dossier",
    strict: true as const,
    schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "schema_version", "outcome", "goal_coverage", "delivered_items",
        "limitations", "tracking_closeout", "evidence_refs",
      ],
      properties: {
        schema_version: { type: "string", const: "butler.btcc-final-dossier.v1" },
        outcome: { type: "string", const: "complete" },
        goal_coverage: {
          type: "array",
          minItems: expectedCriterionIds.length,
          maxItems: expectedCriterionIds.length,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["criterion_id", "status", "evidence_refs"],
            properties: {
              criterion_id: { type: "string", enum: [...expectedCriterionIds] },
              status: { type: "string", const: "passed" },
              evidence_refs: {
                type: "array",
                minItems: 1,
                items: { type: "string" },
                uniqueItems: true,
              },
            },
          },
        },
        delivered_items: stringArraySchema(50),
        limitations: stringArraySchema(30),
        tracking_closeout: { type: "string", minLength: 1, maxLength: 1200 },
        evidence_refs: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          uniqueItems: true,
        },
      },
    },
  };
}

function reportGuardResponseFormat() {
  return {
    type: "json_schema" as const,
    name: "butler_btcc_report_guard",
    strict: true as const,
    schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "outcome", "summary", "reason_code", "required_change", "criterion_verdicts",
      ],
      properties: {
        outcome: { type: "string", enum: ["passed", "return_ticket"] },
        summary: { type: "string", minLength: 1, maxLength: 1000 },
        reason_code: { type: ["string", "null"], maxLength: 160 },
        required_change: { type: ["string", "null"], maxLength: 1200 },
        criterion_verdicts: {
          type: "array",
          minItems: BTCC_REPORT_CRITERIA.length,
          maxItems: BTCC_REPORT_CRITERIA.length,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["criterion_id", "status", "finding_code", "required_change"],
            properties: {
              criterion_id: { type: "string", enum: [...BTCC_REPORT_CRITERIA] },
              status: { type: "string", enum: ["passed", "failed"] },
              finding_code: { type: ["string", "null"], maxLength: 160 },
              required_change: { type: ["string", "null"], maxLength: 1200 },
            },
          },
        },
      },
    },
  };
}

function reporterResponseFormat(
  reportingItemRefs: readonly string[],
  evidenceRefs: readonly string[],
) {
  return {
    type: "json_schema" as const,
    name: "butler_btcc_report_candidate",
    strict: true as const,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["report_text", "reporting_item_refs", "evidence_refs"],
      properties: {
        report_text: { type: "string", minLength: 1, maxLength: 20_000 },
        reporting_item_refs: {
          type: "array",
          minItems: reportingItemRefs.length,
          maxItems: reportingItemRefs.length,
          uniqueItems: true,
          items: { type: "string", enum: [...reportingItemRefs] },
        },
        evidence_refs: {
          type: "array",
          minItems: evidenceRefs.length,
          maxItems: evidenceRefs.length,
          uniqueItems: true,
          items: evidenceRefs.length > 0
            ? { type: "string", enum: [...evidenceRefs] }
            : { type: "string" },
        },
      },
    },
  };
}

function parseReporterCandidate(
  raw: string,
  requiredReportingItemRefs: readonly string[],
  admittedEvidenceRefs: readonly string[],
): { text: string; reportingItemRefs: string[]; evidenceRefs: string[] } {
  const record = parseRecord(raw, "btcc_report_candidate_invalid_json");
  const reportingItemRefs = strings(record.reporting_item_refs);
  const evidenceRefs = strings(record.evidence_refs);
  assertExactCriterionFrontier(
    reportingItemRefs,
    requiredReportingItemRefs,
    "btcc_report_candidate_item_coverage_invalid",
  );
  assertExactCriterionFrontier(
    evidenceRefs,
    admittedEvidenceRefs,
    "btcc_report_candidate_evidence_coverage_invalid",
  );
  return {
    text: requiredString(record.report_text),
    reportingItemRefs,
    evidenceRefs,
  };
}

function parseDossier(
  raw: string,
  admittedEvidenceRefs: Set<string>,
  expectedCriterionIds: readonly string[],
): BtccFinalDossierV1 {
  const record = parseRecord(raw, "btcc_consolidation_invalid_json");
  if (record.schema_version !== "butler.btcc-final-dossier.v1" || record.outcome !== "complete") {
    throw new Error("btcc_consolidation_outcome_invalid");
  }
  const evidenceRefs = strings(record.evidence_refs);
  const goalCoverage = records(record.goal_coverage).map((item) => ({
    criterionId: requiredString(item.criterion_id),
    status: "passed" as const,
    evidenceRefs: strings(item.evidence_refs),
  }));
  if (evidenceRefs.length === 0 || goalCoverage.some((item) => item.evidenceRefs.length === 0)) {
    throw new Error("btcc_consolidation_evidence_missing");
  }
  assertExactCriterionFrontier(
    goalCoverage.map((item) => item.criterionId),
    expectedCriterionIds,
    "btcc_consolidation_criterion_frontier_invalid",
  );
  const referenced = [...evidenceRefs, ...goalCoverage.flatMap((item) => item.evidenceRefs)];
  if (referenced.some((ref) => !admittedEvidenceRefs.has(ref))) {
    throw new Error("btcc_consolidation_evidence_ref_not_admitted");
  }
  return {
    schemaVersion: "butler.btcc-final-dossier.v1",
    outcome: "complete",
    goalCoverage,
    deliveredItems: strings(record.delivered_items),
    limitations: strings(record.limitations),
    trackingCloseout: requiredString(record.tracking_closeout),
    evidenceRefs,
  };
}

function parseReportGuard(raw: string, modelCallRef: string): BtccReportGuardPass | BtccReportGuardGap {
  const record = parseRecord(raw, "btcc_report_guard_invalid_json");
  const summary = requiredString(record.summary);
  const criterionVerdicts = records(record.criterion_verdicts).map((item) => ({
    criterionId: requiredString(item.criterion_id) as BtccReportCriterionId,
    status: reportCriterionStatus(item.status),
    findingCode: nullableString(item.finding_code),
    requiredChange: nullableString(item.required_change),
  }));
  assertExactCriterionFrontier(
    criterionVerdicts.map((item) => item.criterionId),
    BTCC_REPORT_CRITERIA,
    "btcc_report_guard_criterion_frontier_invalid",
  );
  const failed = criterionVerdicts.filter((item) => item.status === "failed");
  if (record.outcome === "passed") {
    if (failed.length > 0 || criterionVerdicts.some((item) =>
      item.findingCode !== null || item.requiredChange !== null)) {
      throw new Error("btcc_report_guard_pass_frontier_invalid");
    }
    return { outcome: "passed", summary, criterionVerdicts, modelCallRef };
  }
  if (record.outcome !== "return_ticket") throw new Error("btcc_report_guard_outcome_invalid");
  if (failed.length === 0 || failed.some((item) => !item.findingCode || !item.requiredChange)) {
    throw new Error("btcc_report_guard_gap_frontier_invalid");
  }
  const reasonCode = requiredString(record.reason_code);
  const requiredChange = requiredString(record.required_change);
  return {
    outcome: "return_ticket",
    summary,
    reasonCode,
    requiredChange,
    criterionVerdicts,
    gapFingerprint: createHash("sha256")
      .update(JSON.stringify({ reasonCode, requiredChange }))
      .digest("hex"),
    modelCallRef,
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function reportCriterionStatus(value: unknown): "passed" | "failed" {
  if (value !== "passed" && value !== "failed") {
    throw new Error("btcc_report_guard_criterion_status_invalid");
  }
  return value;
}

function auditEvidenceRefs(audit: ToolAuditEntry[]): string[] {
  return audit.map((entry, index) => `terminal-evidence:${createHash("sha256")
    .update(JSON.stringify({ index, name: entry.name, args: entry.args, ok: entry.ok }))
    .digest("hex").slice(0, 24)}`);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function assertExactCriterionFrontier(
  actual: readonly string[],
  expected: readonly string[],
  code: string,
): void {
  const expectedSet = new Set(expected);
  if (actual.length !== expected.length || new Set(actual).size !== actual.length ||
    actual.some((id) => !expectedSet.has(id))) {
    throw new Error(code);
  }
}

function sections(id: string, prompt: string): PromptUsageSectionAttribution[] {
  return [{ id, chars: prompt.length, estimatedTokens: Math.ceil(prompt.length / 4) }];
}

function stringArraySchema(maxItems: number): Record<string, unknown> {
  return { type: "array", maxItems, items: { type: "string", minLength: 1, maxLength: 800 } };
}

function parseRecord(raw: string, code: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message === code) throw error;
    throw new Error(code, { cause: error });
  }
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("btcc_terminal_array_invalid");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("btcc_terminal_item_invalid");
    }
    return item as Record<string, unknown>;
  });
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("btcc_terminal_string_array_invalid");
  }
  return value.map((item) => String(item).trim());
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("btcc_terminal_string_missing");
  return value.trim();
}
