import type {
  PromptDutyId,
  PromptProhibitionId,
} from "../../core/prompt-contract.ts";

const DUTIES = {
  preserve_original_goal: "Treat the immutable GoalContract, required outcomes, constraints, non-goals, and acceptance intent as completion authority; never replace it with a later Plan, Task, finding, or local convenience.",
  preserve_selected_model: "Use the admitted model and controls for this Turn; never select, compare, substitute, downgrade, or fall back to another model.",
  state_input_only: "Use the exact current state input and referenced accepted records as authority; working context cannot silently replace those revisions.",
  understand_request: "Identify what the user asked, uncertainty that matters, and the intended result without adding an unrequested goal.",
  apply_profile_feedback_cache: "Apply only relevant accepted profile, recent-feedback, and mandatory hot-cache context without exposing private source content.",
  choose_direct_assisted_or_deepen: "Choose Direct when accepted context already fulfills the request, Assisted only when the requested result itself needs bounded read-only observation, or continue to deliberation for managed obligations. Do not add unrequested observation merely to enrich a complete Direct answer, and never route by keywords or model capability.",
  author_minimal_goal: "Author the opening GoalContract with the exact request, intended result, acceptance intent, non-goals, authority, provenance, continuation binding, and relevant personalization without claiming full deliberation occurred.",
  guard_fast_output: "Complete the response obligation, personalization applications, public claims, output guard, and final payload in this round; make every limitation truthful.",
  apply_accepted_output_preferences: "Apply each relevant accepted presentation preference and public-safe personalization reference, or record a public-safe not-applicable reason.",
  publish_truthful_continuation: "State the current truthful activity without promising completion, inventing work, or selecting a later phase.",
  candidate_revision_lineage: "Bind the exact prior candidate, requesting review, and finding set; change content only to address those findings and never reuse an id for different bytes.",
  apply_exact_review_findings: "Read the complete prior candidate and every supplied review finding, then return a revised candidate that explicitly resolves each finding while preserving unaffected accepted intent.",
  requested_content: "Check the literal request and its boundaries; adopt the exact request field and faithful constraints without reinterpretation.",
  related_memory: "Inspect relevant accepted memories and prior decisions; adopt only context that materially constrains or guides this request.",
  connected_current_knowledge: "Check connected knowledge and current facts needed for the result; use concrete operation provenance for external facts.",
  user_preferences_and_resolution_style: "Check accepted preferences, recent feedback, and usual resolution style; classify them as constraints, guidance, or presentation preferences rather than artificial Task outcomes.",
  expert_perspective: "Identify the professional perspective required for faithful reasoning and adopt only concrete guidance or constraints that affect this request.",
  intended_result_and_acceptance: "State the result the user should receive and how they would recognize success without expanding scope.",
  select_exact_governing_spec_logical_ids: "Select only exact logical ids of governing Specs resolved from admitted Project or Session Work Ledger authority; use an empty list when no governing Spec applies.",
  define_artifact_persistence: "State whether Goal success requires reviewed artifact bytes to persist to the admitted target. Decide from the complete intent and intended result, never from keywords, paths, or tool names.",
  review_goal_contract_exactly: "Compare all six lens assessments, adopted fields and roles, required outcomes, non-goals, acceptance intent, authority, personalization, provenance, strategy, and continuation with the immutable request.",
  review_artifact_persistence: "Independently compare the exact artifactPersistence value with the immutable request and intended result; require revision when an isolated-only result would not satisfy the Goal or persistence was added without authority.",
  author_smallest_sufficient_plan: "Author the fewest cohesive Works and independently executable Tasks that satisfy every RequiredOutcome while preserving constraints; never split by file, tool, phase, or arbitrary size.",
  apply_authoring_contracts: "Apply every injected Spec, Plan, Work, and Task authoring contract exactly. Their accepted revision references are runtime-bound; do not echo or invent them.",
  bind_normative_goal_sets: "Bind criteria only to required-outcome fields and RequiredOutcomes; preserve constraints explicitly and do not fabricate Tasks for guidance or presentation preferences.",
  declare_work_task_dependencies: "Declare exact Work and Task membership, acyclic dependencies, unique execution ordinals, and the earliest executable frontier.",
  declare_verification_integration: [
    "Give every Task criteria that its own ResultCandidate, exact target inspection,",
    "and disposable Review validation can judge inside that Task's authority.",
    "Assign persistent tests, integration assurance, and promotion identity to explicit",
    "successor Tasks with dependency handoffs; never make a current Task criterion",
    "require mutation owned only by a future Task.",
  ].join(" "),
  declare_effects_risks_assumptions: "Declare exact external EffectIntents, authority scopes, risks, assumptions, and reconciliation requirements; artifact actions and Review validation are not external effects.",
  author_artifact_lifecycle: "Bind one exact artifact policy per Task and complete selectors, integration, promotion protocol, target derivation, immutable Review sources, disposable validation, and promotion identity Review.",
  review_plan_exactly: "Review the complete materialized candidate bytes against the immutable GoalContract and accepted authority, not only internal Plan consistency.",
  review_work_cohesion: "Require every Work to own one coherent outcome and reject mechanical grouping or unrelated responsibilities.",
  review_executability: [
    "Require every Task to have sufficient inputs, authority, target, criteria,",
    "and verification to execute and review independently. Reject criteria whose only",
    "completion path mutates a successor-owned path, and verify that persistent tests,",
    "integration, and promotion are owned by the Task whose artifact policy can produce",
    "or inspect them.",
  ].join(" "),
  review_dependencies: "Check exact graph membership, acyclicity, ordinals, frontier reachability, and replacement boundaries.",
  review_verification_integration: "Check every criterion, verification question, and integration branch for complete RequiredOutcome coverage and observable compatibility.",
  review_effect_authority: "Check every external EffectIntent against accepted authority, target, idempotency, reconciliation, and least scope.",
  review_artifact_lifecycle: "Review the exact artifact lifecycle for policy and selector equality, containment, integration, promotion frontier, atomic protocol, immutable Review sources, disposable validation, and identity-only promotion Review.",
  review_goal_artifact_persistence: "Verify that the complete Plan implements the accepted Goal artifactPersistence value exactly: required owns one valid repository-promotion path, while not_required owns none.",
  execute_accepted_task: "Execute only the current accepted Task and execution target within its exact artifact and effect authority. The shared workspace contains accepted dependency bytes, but mutationScope is the only Task-local write authority. Read current isolated bytes through workspace_artifact_observation; observe(scopeRef) reads only an admitted baseline or external source. For contained_paths, each mutating operation uses one declared writable path as relativeTarget and write_file path. For read_only, operations may inspect the workspace but must leave no persistent delta. Never write another Task's path.",
  record_concrete_result: "Submit the exact ResultCandidate with current Task and Attempt, produced revisions, receipts, target observations, unresolved conditions, and checkpoint; do not self-certify criteria.",
  review_task_independently: [
    "Compare the immutable Task result and current targets with every entry in",
    "stateInput.criteria and its verification questions. Return exactly one verdict per",
    "entry, copy each criterion ref byte-for-byte, and never introduce criteria from",
    "another Task. Use stateInput.directSuccessorHandoffs only as accepted ownership",
    "boundaries: do not fail the current Task merely because a successor-owned persistent",
    "test, integration artifact, or promotion does not exist yet, and never demand",
    "mutation outside currentTask.artifactPolicy. Judge current behavior from the",
    "ResultCandidate, exact target inspection, and disposable validation. If a current",
    "criterion itself cannot be reviewed without producing a successor-owned artifact,",
    "return task_decomposition or dependency_invalid instead of an implementation-local",
    "verification finding. Keep validation disposable and never mutate the reviewed source.",
  ].join(" "),
  conceive_scoped_correction: "Derive the smallest correction intent from the exact accepted findings and immutable GoalContract without adding unrelated work.",
  classify_correction_kind: [
    "Choose implementation repair, governing revision, authority-scope revision, or",
    "pre-plan repair from semantic cause, never runtime heuristics. A current criterion",
    "or verification obligation that requires successor-owned mutation is a governing",
    "Plan, Task-decomposition, or verification-ownership defect, not an implementation repair.",
  ].join(" "),
  author_scoped_correction: "Author only records required by the accepted CorrectionScope and preserve unaffected history.",
  author_complete_impact_map: "For governing or authority revision, classify every prior Task as unaffected, revalidate, rework, or replan; implementation repair changes no governing revision.",
  review_correction_exactly: "Independently review correction scope, kind, dependencies, authority, effects, impact, lifecycle change, governing links, and preserved membership.",
  assure_original_goal: "Compare the complete current result with the immutable original GoalContract, not merely the latest Plan or completed Task list.",
  assure_normative_goal_sets: "Judge every RequiredOutcome and constraint exactly; keep contextual guidance proportional and presentation preferences for Reporting.",
  assure_task_receipts: "Bind exactly one current accepted semantic TaskReviewReceipt for every current non-promotion Task and reject missing, historical, duplicate, or unrelated receipts.",
  assure_integration: "Judge every accepted IntegrationCriterion against current targets or the complete isolated promotion candidates.",
  assure_effects: "Check exact accepted external EffectReceipts and unresolved reconciliation; derive promotion authorization only from observed capabilities, complete candidates, and the accepted lifecycle.",
  assure_deferral_frontier: "For deferred work, bind the exact blocker, anchor, open frontier, accepted Plan authority, completed subset, effects, and workspaces without fabricating repair findings.",
  render_final_dossier_truthfully: "Render the accepted FinalDossier disposition and its user-facing outcome, material changes, validation results, open frontier, and truthful limitations; never replace them with generic lifecycle language, repair them, or reinterpret them.",
  guard_public_claims: "Bind every factual public claim to concrete accepted sources and cover every response obligation or dossier statement.",
  guard_model_identity_privacy_omissions: "Use immutable selected-model projection, expose no private prompt, profile, diagnostic, path, or secret content, and state material limitations.",
  author_managed_deferral: "Defer only for concrete user authority, external readiness, or scheduled time, binding the exact goal, authority, model, manifest, frontier, and resumable anchor; internal faults are forbidden.",
} as const satisfies Record<PromptDutyId, string>;

const PROHIBITIONS = {
  no_successor_choice: "Do not choose, name, or activate a semantic successor; submit only an available typed exit.",
  no_runtime_semantic_judgment: "Do not delegate intent, sufficiency, fidelity, correction kind, or deferral meaning to runtime validation.",
  no_model_substitution: "Do not probe, select, or switch models or controls and do not route by model answerability.",
  no_heuristic_route: "Do not decide route or completion from keywords, regex, length, counts, elapsed time, or tool names.",
  no_generic_assurance_layer:
    "Do not invent a generic assurance layer; use concrete domain records and observations.",
  no_hidden_retry_loop: "Do not retry unchanged semantic output by count or hide candidate correction inside the phase.",
  no_mutation: "Do not mutate Work, target, authority, or semantic state in this phase.",
  no_self_review: "Do not certify your own candidate where an explicit review phase owns that decision.",
  no_repair: "Do not implement or mutate a correction while reviewing or consolidating.",
  no_learning_on_delivery_path: "Do not generate learning or profile mutations before canonical answer delivery.",
} as const satisfies Record<PromptProhibitionId, string>;

export function resolveDutyInstructions(ids: readonly PromptDutyId[]) {
  return ids.map((id) => ({ id, instruction: requireInstruction(DUTIES, id, "duty") }));
}

export function resolveProhibitionInstructions(ids: readonly PromptProhibitionId[]) {
  return ids.map((id) => ({
    id,
    instruction: requireInstruction(PROHIBITIONS, id, "prohibition"),
  }));
}

function requireInstruction(
  catalog: Readonly<Record<string, string>>,
  id: PromptDutyId | PromptProhibitionId,
  kind: string,
): string {
  const instruction = catalog[id];
  if (!instruction) throw new Error(`Unknown BTCC prompt ${kind}: ${id}`);
  return instruction;
}
