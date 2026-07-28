import {
  runPhaseConversation,
  type PhaseCodec,
  type PhaseContract,
  type PhaseInvocation,
} from "../../core/index.ts";
import { assistedAnswerSubmissionSchema } from "../submission-schemas.ts";
import type { OpeningAnswerProduct } from "../opening/contracts.ts";
import { decodeOpeningAnswerProduct } from "../opening/opening-answer-codec.ts";

const CONTRACT: PhaseContract = {
  phase: "assisted_answer",
  operationSurface: "authorized",
  objective: "observe_and_complete_a_bounded_answer",
  duties: [
    "preserve_selected_model",
    "state_input_only",
    "understand_request",
    "apply_profile_feedback_cache",
    "complete_bounded_turn_local_effect",
    "guard_public_claims",
    "apply_accepted_output_preferences",
  ],
  prohibitions: [
    "no_successor_choice",
    "no_runtime_semantic_judgment",
    "no_model_substitution",
    "no_heuristic_route",
    "no_generic_assurance_layer",
    "no_hidden_retry_loop",
  ],
};

const codec: PhaseCodec<OpeningAnswerProduct> = {
  submissionSchema: assistedAnswerSubmissionSchema,
  decode: decodeOpeningAnswerProduct,
};

export function answerWithAssistance(
  phase: PhaseInvocation,
): Promise<OpeningAnswerProduct> {
  return runPhaseConversation({
    ...phase,
    phaseContract: CONTRACT,
    codec,
  });
}
