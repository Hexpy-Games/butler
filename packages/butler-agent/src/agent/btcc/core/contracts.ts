import type { AdmittedModelSelection } from "../contracts.ts";

export type PhaseRunBinding = {
  turnId: string;
  turnRevision: number;
  semanticState: "conception_opening";
  checkpointId: string;
  checkpointRevision: number;
  claimId: string;
  executionFence: number;
};

export type OpeningContext = {
  originalMessageId: string;
  originalMessage: string;
  userRef: string;
  projectRef?: string;
  profileRefs: string[];
  recentFeedbackRefs: string[];
  mandatoryHotCacheRefs: string[];
  optionalHotCacheRefs: string[];
};

export type PhaseEnvelope = {
  binding: PhaseRunBinding;
  phase: "conception_opening";
  objective: "understand_and_answer_or_deepen";
  duties: readonly [
    "preserve_selected_model",
    "state_input_only",
    "understand_request",
    "apply_profile_feedback_cache",
    "choose_direct_assisted_or_deepen",
    "author_minimal_goal",
    "guard_fast_output",
    "apply_accepted_output_preferences",
  ];
  prohibitions: readonly [
    "no_successor_choice",
    "no_runtime_semantic_judgment",
    "no_model_substitution",
    "no_heuristic_route",
    "no_generic_evidence",
    "no_hidden_retry_loop",
    "no_mutation",
  ];
  modelSelection: AdmittedModelSelection;
  context: OpeningContext;
};

export type PhaseContract = Pick<
  PhaseEnvelope,
  "phase" | "objective" | "duties" | "prohibitions"
>;

export type ActualModelIdentity = {
  provider: string;
  model: string;
  reasoningEffort: string;
  controlsHash: string;
};

export type ProviderRoundValue =
  | {
      kind: "phase_submission";
      submission: unknown;
      actualIdentity: ActualModelIdentity;
    }
  | {
      kind: "interruption";
      code: string;
    };

export interface SelectedModel {
  runRound(envelope: PhaseEnvelope): Promise<ProviderRoundValue>;
}

export interface PhaseConversationStore {
  loadAcceptedProduct<Product>(binding: PhaseRunBinding): Promise<Product | null>;
  persistAcceptedProduct<Product>(input: {
    binding: PhaseRunBinding;
    product: Product;
    actualIdentity: ActualModelIdentity;
  }): Promise<void>;
}

export type PhaseCodec<Product> = {
  decode(submission: unknown, envelope: PhaseEnvelope): Product;
};

export type PhaseConversationCommand<Product> = {
  binding: PhaseRunBinding;
  modelSelection: AdmittedModelSelection;
  context: OpeningContext;
  phaseContract: PhaseContract;
  codec: PhaseCodec<Product>;
  store: PhaseConversationStore;
  model: SelectedModel;
};
