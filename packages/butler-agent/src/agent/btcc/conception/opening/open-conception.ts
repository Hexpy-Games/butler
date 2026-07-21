import {
  runPhaseConversation,
  type PhaseContract,
} from "../../core/index.ts";
import type {
  OpenConceptionCommand,
  OpeningAnswerProduct,
} from "./contracts.ts";
import { openingAnswerCodec } from "./opening-answer-codec.ts";

const OPENING_PHASE_CONTRACT: PhaseContract = {
  phase: "conception_opening",
  objective: "understand_and_answer_or_deepen",
  duties: [
    "preserve_selected_model",
    "state_input_only",
    "understand_request",
    "apply_profile_feedback_cache",
    "choose_direct_assisted_or_deepen",
    "author_minimal_goal",
    "guard_fast_output",
    "apply_accepted_output_preferences",
  ],
  prohibitions: [
    "no_successor_choice",
    "no_runtime_semantic_judgment",
    "no_model_substitution",
    "no_heuristic_route",
    "no_generic_evidence",
    "no_hidden_retry_loop",
    "no_mutation",
  ],
};

export async function openConception(
  command: OpenConceptionCommand,
): Promise<OpeningAnswerProduct> {
  return runPhaseConversation({
    binding: command.binding,
    modelSelection: command.modelSelection,
    context: command.context,
    phaseContract: OPENING_PHASE_CONTRACT,
    codec: openingAnswerCodec,
    store: command.conversations,
    model: command.model,
  });
}
