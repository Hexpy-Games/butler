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
        acceptedPlanRef: planRef,
        planningReviewRef,
        candidateRefs,
        resolutionRefs,
        promotionTaskRefs,
        assessment: "authorized" as const,
      };
      return {
        kind: "promotion_authorization",
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
      dossier: { ref: contentRef("final-dossier", body), ...body },
    };
  },
};

export function assureOriginalGoal(command: PhaseInvocation) {
  return runPhaseConversation({ ...command, phaseContract: CONTRACT, codec });
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
