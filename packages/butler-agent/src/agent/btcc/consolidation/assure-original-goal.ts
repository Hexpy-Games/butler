import {
  contentRef,
  requireLiteral,
  requireRecord,
  requireString,
  runPhaseConversation,
  stableJson,
  type ContentRef,
  type PhaseCodec,
  type PhaseContract,
  type PhaseInvocation,
} from "../core/index.ts";
import type { ConsolidationProduct } from "./contracts.ts";
import type { ManagedDeferralProduct } from "../deferral/index.ts";
import { decodeAssessment, isRepairableAssessment } from "./decode-assessment.ts";

const CONTRACT: PhaseContract = {
  phase: "consolidation",
  objective: "assure_the_complete_result_against_the_original_goal",
  duties: [
    "preserve_original_goal", "preserve_selected_model", "state_input_only",
    "assure_original_goal", "assure_normative_goal_sets", "assure_task_receipts",
    "assure_integration", "assure_effects", "assure_deferral_frontier",
  ],
  prohibitions: [
    "no_successor_choice", "no_runtime_semantic_judgment", "no_model_substitution",
    "no_heuristic_route", "no_generic_evidence", "no_hidden_retry_loop",
    "no_mutation", "no_repair",
  ],
};

const codec: PhaseCodec<ConsolidationProduct> = {
  decode(submission, envelope) {
    const state = requireRecord(envelope.context.stateInput, "Consolidation state");
    const sourceDeferral = state.sourceDeferral as ManagedDeferralProduct | undefined;
    if (sourceDeferral?.kind === "managed_deferral") {
      return decodeDeferredDossier(submission, state, sourceDeferral);
    }
    if (state.frontier !== "closed" && state.frontier !== "awaiting_consolidation") {
      throw new Error("Consolidation requires a closed implementation frontier");
    }
    if (!Array.isArray(state.taskStatuses) || state.taskStatuses.some((status) => status !== "accepted")) {
      throw new Error("Consolidation requires every accepted Task");
    }
    const goalContractRef = requireContentRef(state.goalContractRef, "goalContractRef");
    const authorityRef = requireContentRef(state.authorityRef, "authorityRef");
    const planRef = requireContentRef(state.planRef, "planRef");
    const planningReviewRef = requireContentRef(state.planningReviewRef, "planningReviewRef");
    const taskReviewRefs = requireContentRefs(state.taskReviewRefs, "taskReviewRefs");
    const value = requireRecord(submission, "Consolidation submission");
    const assessment = decodeAssessment(value, state);
    if (value.kind === "consolidation_repair") {
      if (!isRepairableAssessment(assessment)) {
        throw new Error("Consolidation repair has no repairable whole-goal verdict");
      }
      return decodeRepair(value, assessment, currentTaskRefs(state));
    }
    if (isRepairableAssessment(assessment)) {
      throw new Error("Consolidation cannot close a repairable whole-goal finding");
    }
    const promotionAssemblies = Array.isArray(state.promotionAssemblies)
      ? state.promotionAssemblies.map((item, index) =>
          requireRecord(item, `promotionAssemblies[${index}]`))
      : [];
    if (promotionAssemblies.length > 0) {
      requireLiteral(value.kind, "promotion_authorization", "Consolidation kind");
      requireLiteral(value.goalCoverage, "fulfilled", "goal coverage");
      requireLiteral(value.semanticFidelity, "faithful", "semantic fidelity");
      const candidateRefs = promotionAssemblies.map((assembly) =>
        requireContentRef(requireRecord(assembly.candidate, "candidate").ref, "candidate.ref"));
      const resolutionRefs = promotionAssemblies.map((assembly) =>
        requireContentRef(requireRecord(assembly.resolution, "resolution").ref, "resolution.ref"));
      const promotionTaskRefs = promotionAssemblies.map((assembly) =>
        requireContentRef(
          requireRecord(assembly.candidate, "candidate").promotionTaskRef,
          "promotionTaskRef",
        ));
      const body = {
        programId: requireString(state.programId, "programId"),
        originalGoalContractRef: goalContractRef,
        currentAuthorityRef: authorityRef,
        assessmentRef: assessment.ref,
        acceptedPlanRef: planRef,
        planningReviewRef,
        candidateRefs,
        resolutionRefs,
        promotionTaskRefs,
        assessment: "authorized" as const,
      };
      return {
        kind: "promotion_authorization",
        assessment,
        authorization: { ref: contentRef("promotion-authorization", body), ...body },
      };
    }
    requireLiteral(value.kind, "final_dossier", "Consolidation kind");
    requireLiteral(value.goalCoverage, "fulfilled", "goal coverage");
    requireLiteral(value.semanticFidelity, "faithful", "semantic fidelity");
    if (stableJson(value.originalGoalContractRef) !== stableJson(goalContractRef)) {
      throw new Error("Consolidation did not assess the immutable original GoalContract");
    }
    const body = {
      programId: requireString(state.programId, "programId"),
      originalGoalContractRef: goalContractRef,
      currentAuthorityRef: authorityRef,
      consolidationAssessmentRef: assessment.ref,
      acceptedPlanRef: planRef,
      planningReviewRef,
      taskReviewRefs,
      goalCoverage: "fulfilled" as const,
      semanticFidelity: "faithful" as const,
      promotionClosure: "not_required" as const,
      disposition: "completed" as const,
      summary: requireString(value.summary, "summary"),
    };
    return {
      kind: "final_dossier",
      assessment,
      dossier: { ref: contentRef("final-dossier", body), ...body },
    };
  },
};

export function assureOriginalGoal(command: PhaseInvocation) {
  return runPhaseConversation({ ...command, phaseContract: CONTRACT, codec });
}

function decodeRepair(
  value: Record<string, unknown>,
  assessment: import("./contracts.ts").ConsolidationAssessment,
  taskRefs: [ContentRef, ...ContentRef[]],
): ConsolidationProduct {
  const findings = requireStringList(value.findings, "Consolidation findings");
  const affectedTaskRefs = requireExactTaskSubset(value.affectedTaskRefs, taskRefs);
  const findingSet = {
    findings,
    ref: contentRef("consolidation-finding-set", { findings }),
  };
  const unfulfilledFieldIds = assessment.goalFieldVerdicts
    .filter((verdict) => verdict.verdict === "not_fulfilled")
    .map((verdict) => verdict.fieldId);
  const correctionBody = {
    origin: "consolidation" as const,
    findingsRef: findingSet.ref,
    sourceGoalFieldIds: (unfulfilledFieldIds.length > 0
      ? unfulfilledFieldIds
      : assessment.goalFieldVerdicts.map((verdict) => verdict.fieldId)) as [string, ...string[]],
    affectedTaskRefs,
  };
  const correctionScope = {
    ref: contentRef("correction-scope", correctionBody),
    ...correctionBody,
  };
  const body = { findingSet, correctionScope };
  return {
    kind: "consolidation_repair",
    assessment,
    repair: { ref: contentRef("consolidation-repair", body), ...body },
  };
}

function decodeDeferredDossier(
  submission: unknown,
  state: Record<string, unknown>,
  deferral: ManagedDeferralProduct,
): ConsolidationProduct {
  const value = requireRecord(submission, "Deferred Consolidation submission");
  requireLiteral(value.kind, "final_dossier", "Consolidation kind");
  requireLiteral(value.goalCoverage, "deferred", "goal coverage");
  requireLiteral(value.semanticFidelity, "faithful", "semantic fidelity");
  const goalContractRef = requireContentRef(state.goalContractRef, "goalContractRef");
  const authorityRef = requireContentRef(state.authorityRef, "authorityRef");
  const assessment = decodeAssessment({
    goalFieldVerdicts: requireGoalFields(state).map((field) => ({
      fieldId: field.fieldId,
      verdict: "deferred",
    })),
    taskCompatibility: {
      reviewedTaskRefs: Array.isArray(state.taskReviewRefs) ? state.taskReviewRefs : [],
      verdict: Array.isArray(state.taskReviewRefs) && state.taskReviewRefs.length > 0
        ? "deferred"
        : "compatible",
    },
    semanticFidelity: "faithful",
  }, state);
  const plan = deferral.anchor.planAuthority.kind === "accepted_plan"
    ? {
        acceptedPlanRef: deferral.anchor.planAuthority.acceptedPlanRef,
        planningReviewRef: deferral.anchor.planAuthority.planningReviewRef,
      }
    : {};
  const body = {
    programId: requireString(state.programId, "programId"),
    originalGoalContractRef: goalContractRef,
    currentAuthorityRef: authorityRef,
    consolidationAssessmentRef: assessment.ref,
    ...plan,
    taskReviewRefs: [] as ContentRef[],
    goalCoverage: "deferred" as const,
    semanticFidelity: "faithful" as const,
    promotionClosure: "not_required" as const,
    disposition: "deferred" as const,
    blockerRef: deferral.blocker.ref,
    deferredAnchorRef: deferral.anchor.ref,
    openWorkRefs: deferral.anchor.openWorkRefs,
    continuationOpenTaskRefs: deferral.anchor.openTaskRefs,
    summary: requireString(value.summary, "summary"),
  };
  return {
    kind: "final_dossier",
    assessment,
    dossier: { ref: contentRef("final-dossier", body), ...body },
  };
}

function requireContentRefs(value: unknown, label: string): [ContentRef, ...ContentRef[]] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} is empty`);
  return value.map((item, index) =>
    requireContentRef(item, `${label}[${index}]`)) as [ContentRef, ...ContentRef[]];
}

function requireContentRef(value: unknown, label: string): ContentRef {
  const record = requireRecord(value, label);
  return { id: requireString(record.id, `${label}.id`), sha256: requireString(record.sha256, `${label}.sha256`) };
}

function requireGoalFields(state: Record<string, unknown>): Array<{ fieldId: string }> {
  const fields = state.goalFields;
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error("Consolidation goal fields are empty");
  }
  return fields.map((field, index) => ({
    fieldId: requireString(requireRecord(field, `goalFields[${index}]`).fieldId, "fieldId"),
  }));
}

function currentTaskRefs(state: Record<string, unknown>): [ContentRef, ...ContentRef[]] {
  return requireContentRefs(state.taskRefs, "taskRefs");
}

function requireStringList(value: unknown, label: string): [string, ...string[]] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be nonempty`);
  }
  return value as [string, ...string[]];
}

function requireExactTaskSubset(
  value: unknown,
  available: [ContentRef, ...ContentRef[]],
): [ContentRef, ...ContentRef[]] {
  const selected = requireContentRefs(value, "affectedTaskRefs");
  const availableIds = new Set(available.map((ref) => ref.id));
  const selectedIds = selected.map((ref) => ref.id);
  if (new Set(selectedIds).size !== selectedIds.length || selectedIds.some((id) => !availableIds.has(id))) {
    throw new Error("Consolidation repair affected Tasks are not an exact current subset");
  }
  return selected;
}
