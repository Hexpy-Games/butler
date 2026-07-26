export const PROMPT_DUTY_IDS = [
  "preserve_original_goal", "preserve_selected_model", "state_input_only",
  "understand_request", "apply_profile_feedback_cache",
  "choose_direct_assisted_or_deepen", "author_minimal_goal", "guard_fast_output",
  "apply_accepted_output_preferences", "publish_truthful_continuation",
  "candidate_revision_lineage", "apply_exact_review_findings",
  "requested_content", "related_memory",
  "connected_current_knowledge", "user_preferences_and_resolution_style",
  "expert_perspective", "intended_result_and_acceptance",
  "map_governing_spec_applicability", "define_artifact_persistence",
  "review_goal_contract_exactly", "review_continuation_coherence",
  "review_artifact_persistence",
  "author_smallest_sufficient_plan", "apply_authoring_contracts",
  "bind_normative_goal_sets", "declare_work_task_dependencies",
  "declare_verification_integration", "declare_effects_risks_assumptions",
  "author_artifact_lifecycle", "review_plan_exactly", "review_work_cohesion",
  "review_executability", "review_dependencies", "review_verification_integration",
  "review_effect_authority", "review_artifact_lifecycle",
  "review_goal_artifact_persistence", "execute_accepted_task",
  "record_concrete_result", "review_task_independently", "conceive_scoped_correction",
  "classify_correction_kind", "author_scoped_correction", "author_complete_impact_map",
  "review_correction_exactly", "select_correction_revision_target",
  "assure_original_goal", "assure_normative_goal_sets",
  "assure_task_receipts", "assure_integration", "assure_effects",
  "assure_deferral_frontier", "render_final_dossier_truthfully", "guard_public_claims",
  "guard_model_identity_privacy_omissions", "author_managed_deferral",
] as const;

export const PROMPT_PROHIBITION_IDS = [
  "no_successor_choice", "no_runtime_semantic_judgment", "no_model_substitution",
  "no_heuristic_route", "no_generic_assurance_layer", "no_hidden_retry_loop", "no_mutation",
  "no_self_review", "no_repair", "no_learning_on_delivery_path",
] as const;

export type PromptDutyId = typeof PROMPT_DUTY_IDS[number];
export type PromptProhibitionId = typeof PROMPT_PROHIBITION_IDS[number];
