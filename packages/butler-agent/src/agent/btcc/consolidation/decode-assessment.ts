import {
  contentRef,
  requireRecord,
  requireString,
  type ContentRef,
} from "../core/index.ts";
import type { ConsolidationAssessment } from "./contracts.ts";

export function decodeAssessment(
  value: Record<string, unknown>,
  state: Record<string, unknown>,
): ConsolidationAssessment {
  const goalContractRef = requireContentRef(state.goalContractRef, "goalContractRef");
  const authorityRef = requireContentRef(state.authorityRef, "authorityRef");
  const goalFieldVerdicts = decodeGoalFieldVerdicts(value.goalFieldVerdicts, state.goalFields);
  const taskReviewRefs = requireContentRefs(state.taskReviewRefs, "taskReviewRefs", true);
  const taskCompatibility = decodeTaskCompatibility(value.taskCompatibility, taskReviewRefs);
  const semanticFidelity = value.semanticFidelity;
  if (semanticFidelity !== "faithful" && semanticFidelity !== "drift_detected") {
    throw new Error("Consolidation semantic fidelity is invalid");
  }
  const body = {
    programId: requireString(state.programId, "programId"),
    originalGoalContractRef: goalContractRef,
    currentAuthorityRef: authorityRef,
    ...(state.planRef ? { acceptedPlanRef: requireContentRef(state.planRef, "planRef") } : {}),
    ...(state.planningReviewRef
      ? { planningReviewRef: requireContentRef(state.planningReviewRef, "planningReviewRef") }
      : {}),
    taskReviewRefs,
    goalFieldVerdicts,
    taskCompatibility,
    semanticFidelity: semanticFidelity as ConsolidationAssessment["semanticFidelity"],
    candidateRefs: requireContentRefs(state.candidateRefs, "candidateRefs", true),
  };
  return { ref: contentRef("consolidation-assessment", body), ...body };
}

export function isRepairableAssessment(assessment: ConsolidationAssessment): boolean {
  return assessment.semanticFidelity === "drift_detected"
    || assessment.goalFieldVerdicts.some((verdict) => verdict.verdict === "not_fulfilled")
    || assessment.taskCompatibility.verdict === "not_compatible";
}

function decodeGoalFieldVerdicts(
  value: unknown,
  goalFields: unknown,
): ConsolidationAssessment["goalFieldVerdicts"] {
  if (!Array.isArray(goalFields) || goalFields.length === 0 || !Array.isArray(value)) {
    throw new Error("Consolidation requires exact Goal field verdicts");
  }
  const fields = goalFields.map((item, index) =>
    requireString(requireRecord(item, `goalFields[${index}]`).fieldId, `goalFields[${index}].fieldId`));
  if (value.length !== fields.length) throw new Error("Consolidation Goal field verdict set changed");
  const acceptedFields = new Set(fields);
  const reviewedFields = new Set<string>();
  const verdicts = value.map((item, index) => {
    const record = requireRecord(item, `goalFieldVerdicts[${index}]`);
    const fieldId = requireString(record.fieldId, `goalFieldVerdicts[${index}].fieldId`);
    if (!acceptedFields.has(fieldId) || reviewedFields.has(fieldId)) {
      throw new Error("Consolidation changed or repeated an original Goal field");
    }
    reviewedFields.add(fieldId);
    const verdict = record.verdict;
    if (verdict !== "fulfilled" && verdict !== "deferred" && verdict !== "not_fulfilled") {
      throw new Error("Consolidation Goal field verdict does not match the original contract");
    }
    return {
      fieldId,
      verdict: verdict as ConsolidationAssessment["goalFieldVerdicts"][number]["verdict"],
    };
  });
  if (reviewedFields.size !== acceptedFields.size) {
    throw new Error("Consolidation omitted an original Goal field");
  }
  return verdicts;
}

function decodeTaskCompatibility(
  value: unknown,
  taskReviewRefs: ContentRef[],
): ConsolidationAssessment["taskCompatibility"] {
  const record = requireRecord(value, "taskCompatibility");
  const verdict = record.verdict;
  if (verdict !== "compatible" && verdict !== "deferred" && verdict !== "not_compatible") {
    throw new Error("Consolidation Task compatibility verdict is invalid");
  }
  return { reviewedTaskRefs: taskReviewRefs, verdict };
}

function requireContentRefs(value: unknown, label: string, allowEmpty: boolean): ContentRef[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} is invalid`);
  }
  return value.map((item, index) => requireContentRef(item, `${label}[${index}]`));
}

function requireContentRef(value: unknown, label: string): ContentRef {
  const record = requireRecord(value, label);
  return {
    id: requireString(record.id, `${label}.id`),
    sha256: requireString(record.sha256, `${label}.sha256`),
  };
}
