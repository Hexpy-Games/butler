import {
  runPhaseConversation,
  type PhaseContract,
  type PhaseInvocation,
} from "../../core/index.ts";
import type { OpeningProduct } from "./contracts.ts";
import { openingAnswerCodec } from "./opening-answer-codec.ts";

const OPENING_PHASE_CONTRACT: PhaseContract = {
  phase: "conception_opening",
  objective: "understand_and_answer_or_deepen",
  duties: [
    "preserve_selected_model",
    "state_input_only",
    "understand_request",
    "apply_profile_feedback_cache",
    "identify_whether_the_request_creates_a_work_obligation",
    "identify_project_or_session_ledger_binding",
    "choose_direct_assisted_or_deepen",
    "treat_opening_mutation_prohibition_as_a_phase_boundary_not_a_turn_limitation",
  ],
  exitDuties: {
    direct_answer: [
      "use_only_when_the_requested_outcome_is_complete_without_observation_or_work",
      "author_minimal_goal",
      "guard_fast_output",
      "apply_accepted_output_preferences",
    ],
    assisted_answer: [
      "use_only_when_admitted_observations_completely_fulfill_the_request_without_further_work",
      "use_only_admitted_observations",
      "cite_public_claim_sources",
      "guard_fast_output",
      "apply_accepted_output_preferences",
    ],
    opening_continuation: [
      "use_for_any_project_bound_mutation_or_multi_step_work_obligation",
      "use_when_planning_work_or_task_records_are_required",
      "publish_truthful_continuation_without_performing_the_work",
    ],
  },
  prohibitions: [
    "no_successor_choice",
    "no_runtime_semantic_judgment",
    "no_model_substitution",
    "no_heuristic_route",
    "no_generic_evidence",
    "no_hidden_retry_loop",
    "no_mutation",
    "no_reporting_phase_local_mutation_limits_as_turn_level_inability",
  ],
};

export async function openConception(
  command: PhaseInvocation,
): Promise<OpeningProduct> {
  return runPhaseConversation({
    ...command,
    phaseContract: OPENING_PHASE_CONTRACT,
    codec: openingAnswerCodec,
  });
}
