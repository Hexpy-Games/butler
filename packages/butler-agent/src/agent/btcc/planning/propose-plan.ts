import {
  requireLiteral,
  requireRecord,
  requireString,
  runPhaseConversation,
  type ContentRef,
  type PhaseContract,
  type PhaseInvocation,
} from "../core/index.ts";
import type { PlanningCandidateProduct } from "./contracts.ts";
import type { PlanningContinuation } from "./contracts.ts";
import { withManagedDeferral } from "../deferral/index.ts";
import { PLANNING_AUTHORING_CONTRACTS } from "./authoring-contracts.ts";
import { authorPlanCandidate } from "./plan-graph/index.ts";
import { planCandidateSubmissionSchema } from "./submission-schemas.ts";

const CONTRACT: PhaseContract = {
  phase: "planning",
  objective: "author_or_revise_the_complete_managed_work_graph",
  duties: [
    "preserve_original_goal", "preserve_selected_model", "state_input_only",
    "author_smallest_sufficient_plan", "apply_authoring_contracts",
    "bind_normative_goal_sets", "declare_work_task_dependencies",
    "declare_verification_integration", "declare_effects_risks_assumptions",
    "author_artifact_lifecycle", "candidate_revision_lineage",
  ],
  prohibitions: [
    "no_successor_choice", "no_runtime_semantic_judgment", "no_model_substitution",
    "no_heuristic_route", "no_generic_evidence", "no_hidden_retry_loop",
    "no_mutation", "no_self_review",
  ],
  authoringContractRefs: [
    "SPEC-BTCC-WORK-AUTHORING-CONTRACT",
    "SPEC-BTCC-PLANNING-RECORD-CONTRACT",
    "SPEC-BTCC-WORK-LEDGER-STATE-AND-MUTATION-CONTRACT",
  ],
  authoringContracts: PLANNING_AUTHORING_CONTRACTS,
};

const codec = withManagedDeferral<PlanningCandidateProduct>({
  submissionSchema: planCandidateSubmissionSchema,
  decode(submission, envelope) {
    const state = requireRecord(envelope.context.stateInput, "Planning state");
    const value = requireRecord(submission, "Planning submission");
    requireLiteral(value.kind, "plan_candidate", "Planning kind");
    return {
      kind: "plan_candidate",
      candidate: authorPlanCandidate(value, {
        goalContractRef: requireContentRef(state.goalContractRef, "goalContractRef"),
        authorityRef: requireContentRef(state.authorityRef, "authorityRef"),
        requiredOutcomeId: requireString(state.requiredOutcomeId, "requiredOutcomeId"),
        workspaceScopeRef: requireWorkspaceScope(envelope.context.baselineObservationScopeRefs),
        ledgerId: requireString(state.ledgerId, "ledgerId"),
        programId: requireString(state.programId, "programId"),
        observedManifestRevision: requirePositiveInteger(
          state.observedManifestRevision,
          "observedManifestRevision",
        ),
        ...(state.previousCandidateRef
          ? { previousCandidateRef: requireContentRef(state.previousCandidateRef, "previousCandidateRef") }
          : {}),
        ...(state.findingSetRef
          ? { findingSetRef: requireContentRef(state.findingSetRef, "findingSetRef") }
          : {}),
        ...(state.continuation
          ? { continuation: state.continuation as PlanningContinuation }
          : {}),
      }),
    };
  },
});

export function proposePlan(command: PhaseInvocation) {
  return runPhaseConversation({ ...command, phaseContract: CONTRACT, codec });
}

function requireWorkspaceScope(scopeRefs: readonly string[]): string {
  const workspaceScopeRef = scopeRefs.find((scopeRef) => scopeRef.startsWith("workspace:"));
  if (!workspaceScopeRef) throw new Error("Planning requires an admitted workspace scope");
  return workspaceScopeRef;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function requireContentRef(value: unknown, label: string): ContentRef {
  const record = requireRecord(value, label);
  return {
    id: requireString(record.id, `${label}.id`),
    sha256: requireString(record.sha256, `${label}.sha256`),
  };
}
