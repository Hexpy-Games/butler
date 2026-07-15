import { createHash } from "node:crypto";
import type { PromptUsageSectionAttribution } from "../../../integrations/providers/provider.ts";
import type { ToolAuditEntry } from "../native/output/tool-types.ts";
import type { BtccNativePhaseCoordinator } from "./native-phase-coordinator.ts";

export interface BtccIndependentReviewPass {
  outcome: "passed";
  summary: string;
  criterionVerdicts: Array<{
    criterionId: string;
    status: "passed";
    evidenceRefs: string[];
  }>;
  evidenceRefs: string[];
  modelCallRef: string;
}

export interface BtccIndependentReviewGap {
  outcome: "return_ticket";
  summary: string;
  criterionId: string;
  reasonCode: string;
  requiredChange: string;
  evidenceRefs: string[];
  gapFingerprint: string;
  modelCallRef: string;
}

export type BtccIndependentReviewOutcome =
  | BtccIndependentReviewPass
  | BtccIndependentReviewGap;

export async function runBtccIndependentReview(input: {
  coordinator: BtccNativePhaseCoordinator;
  candidateText: string;
  audit: ToolAuditEntry[];
  reviewIndex: number;
  runPrivateTextPrompt: (
    prompt: string,
    phase: string,
    sections: PromptUsageSectionAttribution[],
    responseFormat: ReturnType<typeof reviewResponseFormat>,
  ) => Promise<string>;
}): Promise<BtccIndependentReviewOutcome> {
  const state = input.coordinator.state();
  if (state.currentPhase !== "review") throw new Error("btcc_review_phase_not_active");
  if (!state.activeReviewTargetRef || !state.goalContractRef) {
    throw new Error("btcc_review_authority_missing");
  }
  const goalContract = input.coordinator.goalContract();
  const expectedCriterionIds = goalContract.acceptanceIntents.map((criterion) => criterion.key);
  const modelCallRef = `model-call:review:${state.turnId}:${input.reviewIndex}`;
  const evidence = [
    {
      ref: state.activeReviewTargetRef,
      producer: "btcc_execution_candidate",
      ok: true,
      summary: "Durable execution candidate owned by the active Review generation.",
    },
    {
      ref: state.goalContractRef,
      producer: "btcc_goal_contract",
      ok: true,
      summary: "Immutable goal and acceptance authority for this turn.",
    },
    ...reviewEvidence(input.audit),
  ];
  const prompt = [
    input.coordinator.prompt("task", state.activeTaskRef).text,
    "## Independent Review Capsule",
    JSON.stringify({
      executionCandidateRef: state.activeReviewTargetRef,
      goalContract,
      candidateText: input.candidateText,
      evidence,
    }),
    "Return a criterion-level passed verdict only when the current evidence proves the requested result. Otherwise return one ReturnTicket to Execution. Do not propose or perform a repair in Review.",
  ].join("\n\n");
  const raw = await input.runPrivateTextPrompt(
    prompt,
    "btcc_review",
    [{ id: "btcc_review", chars: prompt.length, estimatedTokens: Math.ceil(prompt.length / 4) }],
    reviewResponseFormat(expectedCriterionIds),
  );
  return parseReview(
    raw,
    modelCallRef,
    evidence.map((item) => item.ref),
    expectedCriterionIds,
  );
}

function reviewResponseFormat(expectedCriterionIds: readonly string[]) {
  return {
    type: "json_schema" as const,
    name: "butler_btcc_independent_review",
    strict: true as const,
    schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "outcome", "summary", "criterion_verdicts", "criterion_id",
        "reason_code", "required_change", "evidence_refs",
      ],
      properties: {
        outcome: { type: "string", enum: ["passed", "return_ticket"] },
        summary: { type: "string", minLength: 1, maxLength: 1200 },
        criterion_verdicts: {
          type: "array",
          minItems: expectedCriterionIds.length,
          maxItems: expectedCriterionIds.length,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["criterion_id", "status", "evidence_refs"],
            properties: {
              criterion_id: { type: "string", enum: [...expectedCriterionIds] },
              status: { type: "string", enum: ["passed"] },
              evidence_refs: {
                type: "array",
                minItems: 1,
                items: { type: "string" },
                uniqueItems: true,
              },
            },
          },
        },
        criterion_id: { type: ["string", "null"], maxLength: 160 },
        reason_code: { type: ["string", "null"], maxLength: 160 },
        required_change: { type: ["string", "null"], maxLength: 1200 },
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

function parseReview(
  raw: string,
  modelCallRef: string,
  admittedEvidenceRefs: string[],
  expectedCriterionIds: readonly string[],
): BtccIndependentReviewOutcome {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("btcc_review_invalid_json");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("btcc_review_invalid_object");
  }
  const record = value as Record<string, unknown>;
  const evidenceRefs = strings(record.evidence_refs);
  const admitted = new Set(admittedEvidenceRefs);
  if (evidenceRefs.some((ref) => !admitted.has(ref))) {
    throw new Error("btcc_review_evidence_ref_not_admitted");
  }
  const summary = requiredString(record.summary, "btcc_review_summary_missing");
  if (record.outcome === "passed") {
    const criterionVerdicts = records(record.criterion_verdicts).map((item) => ({
      criterionId: requiredString(item.criterion_id, "btcc_review_criterion_missing"),
      status: "passed" as const,
      evidenceRefs: strings(item.evidence_refs),
    }));
    if (criterionVerdicts.length === 0) throw new Error("btcc_review_verdicts_missing");
    if (criterionVerdicts.some((item) => item.evidenceRefs.length === 0)) {
      throw new Error("btcc_review_criterion_evidence_missing");
    }
    if (criterionVerdicts.some((item) => item.evidenceRefs.some((ref) => !admitted.has(ref)))) {
      throw new Error("btcc_review_evidence_ref_not_admitted");
    }
    assertExactCriterionFrontier(
      criterionVerdicts.map((item) => item.criterionId),
      expectedCriterionIds,
      "btcc_review_criterion_frontier_invalid",
    );
    return {
      outcome: "passed",
      summary,
      criterionVerdicts,
      evidenceRefs,
      modelCallRef,
    };
  }
  if (record.outcome !== "return_ticket") throw new Error("btcc_review_outcome_invalid");
  const criterionId = requiredString(record.criterion_id, "btcc_review_criterion_missing");
  const reasonCode = requiredString(record.reason_code, "btcc_review_reason_missing");
  const requiredChange = requiredString(record.required_change, "btcc_review_change_missing");
  return {
    outcome: "return_ticket",
    summary,
    criterionId,
    reasonCode,
    requiredChange,
    evidenceRefs,
    gapFingerprint: createHash("sha256").update(JSON.stringify({
      criterionId,
      reasonCode,
      requiredChange,
      evidenceRefs,
    })).digest("hex"),
    modelCallRef,
  };
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

function reviewEvidence(audit: ToolAuditEntry[]): Array<{
  ref: string;
  producer: string;
  ok: boolean;
  summary: string;
}> {
  return audit.map((entry, index) => ({
    ref: `review-evidence:${createHash("sha256").update(JSON.stringify({
      index,
      name: entry.name,
      args: entry.args,
      ok: entry.ok,
    })).digest("hex").slice(0, 24)}`,
    producer: entry.name,
    ok: entry.ok,
    summary: entry.observation?.summary ?? (entry.ok ? "Operation succeeded." : "Operation failed."),
  }));
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("btcc_review_array_invalid");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("btcc_review_item_invalid");
    }
    return item as Record<string, unknown>;
  });
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("btcc_review_refs_invalid");
  }
  return value.map((item) => String(item).trim());
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value.trim();
}
