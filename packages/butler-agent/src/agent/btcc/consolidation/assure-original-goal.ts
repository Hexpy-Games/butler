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
import type { FinalDossierProduct } from "./contracts.ts";

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

const codec: PhaseCodec<FinalDossierProduct> = {
  decode(submission, envelope) {
    const state = requireRecord(envelope.context.stateInput, "Consolidation state");
    requireLiteral(state.frontier, "closed", "Program frontier");
    requireLiteral(state.taskStatus, "accepted", "Task status");
    const goalContractRef = requireContentRef(state.goalContractRef, "goalContractRef");
    const authorityRef = requireContentRef(state.authorityRef, "authorityRef");
    const planRef = requireContentRef(state.planRef, "planRef");
    const planningReviewRef = requireContentRef(state.planningReviewRef, "planningReviewRef");
    const taskReviewRef = requireContentRef(state.taskReviewRef, "taskReviewRef");
    const value = requireRecord(submission, "Consolidation submission");
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
      taskReviewRefs: [taskReviewRef] as [ContentRef],
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

function requireContentRef(value: unknown, label: string): ContentRef {
  const record = requireRecord(value, label);
  return { id: requireString(record.id, `${label}.id`), sha256: requireString(record.sha256, `${label}.sha256`) };
}
