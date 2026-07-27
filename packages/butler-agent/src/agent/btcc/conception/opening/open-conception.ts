import {
  runPhaseConversation,
  type PhaseContract,
  type PhaseInvocation,
} from "../../core/index.ts";
import type { OpeningProduct } from "./contracts.ts";
import { openingAnswerCodec } from "./opening-answer-codec.ts";

const OPENING_PHASE_CONTRACT: PhaseContract = {
  phase: "conception_opening",
  operationSurface: "closed",
  objective: "understand_and_answer_or_deepen",
  duties: [
    "preserve_selected_model",
    "state_input_only",
    "understand_request",
    "apply_profile_feedback_cache",
    "choose_direct_assisted_or_deepen",
  ],
  exitDuties: {
    direct_answer: [
      "author_minimal_goal",
      "guard_fast_output",
      "apply_accepted_output_preferences",
    ],
    assisted_continuation: [
      "publish_truthful_continuation",
    ],
    managed_continuation: [
      "publish_truthful_continuation",
    ],
    managed_program_continuation: [
      "publish_truthful_continuation",
    ],
  },
  prohibitions: [
    "no_successor_choice",
    "no_runtime_semantic_judgment",
    "no_model_substitution",
    "no_heuristic_route",
    "no_generic_assurance_layer",
    "no_hidden_retry_loop",
    "no_mutation",
  ],
};

export async function openConception(
  command: PhaseInvocation,
): Promise<OpeningProduct> {
  return runPhaseConversation({
    ...command,
    phaseContract: OPENING_PHASE_CONTRACT,
    codec: openingAnswerCodec(
      command.context.continuationCandidates?.map(({ candidateId }) => candidateId) ?? [],
    ),
  });
}
