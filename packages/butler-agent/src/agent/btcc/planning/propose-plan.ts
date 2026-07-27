import {
  requireLiteral,
  requireRecord,
  requireString,
  runPhaseConversation,
  type ContentRef,
  type PhaseCodec,
  type PhaseContract,
  type PhaseInvocation,
} from "../core/index.ts";
import type {
  PlanningCandidateProduct,
  PlanningObservationResultIndexEntry,
  PlanningReview,
} from "./contracts.ts";
import type { PlanningContinuation } from "./contracts.ts";
import { PLANNING_AUTHORING_CONTRACTS } from "./authoring-contracts.ts";
import { authorPlanningProposal } from "./plan-graph/index.ts";
import { planCandidateSubmissionSchema } from "./submission-schemas.ts";
import {
  decodeAvailableSpecs,
  selectableGoverningSpecIds,
} from "./decode-available-specs.ts";
import { retainPlanningObservations } from "./observation-result-index.ts";
import {
  decodeFindingDecisions,
  requiredSubjectFindingRefs,
} from "./finding-decisions.ts";
import { assertRevisedPlanChanged } from "./assert-revised-plan-changed.ts";
import {
  applyPlanningDeferralPolicy,
  type PlanningDeferralPolicy,
} from "./deferral-policy.ts";

const CONTRACT: PhaseContract = {
  phase: "planning",
  operationSurface: "authorized",
  objective: "author_or_revise_the_complete_managed_work_graph",
  duties: [
    "preserve_original_goal", "preserve_selected_model", "state_input_only",
    "author_smallest_sufficient_plan", "apply_authoring_contracts",
    "bind_normative_goal_sets", "declare_work_task_dependencies",
    "declare_verification_integration", "declare_effects_risks_assumptions",
    "author_artifact_lifecycle", "candidate_revision_lineage",
    "apply_exact_review_findings",
    "author_managed_deferral",
  ],
  prohibitions: [
    "no_successor_choice", "no_runtime_semantic_judgment", "no_model_substitution",
    "no_heuristic_route", "no_generic_assurance_layer", "no_hidden_retry_loop",
    "no_mutation", "no_self_review",
  ],
  authoringContractRefs: [
    "SPEC-BTCC-WORK-AUTHORING-CONTRACT",
    "SPEC-BTCC-WORK-LEDGER-STATE-AND-MUTATION-CONTRACT",
  ],
  authoringContracts: PLANNING_AUTHORING_CONTRACTS,
};

function planningCodec(
  selectableSpecIds: string[],
  priorFindingRefs: ContentRef[],
  deferralPolicy: PlanningDeferralPolicy,
) {
  const codec: PhaseCodec<PlanningCandidateProduct> = {
    submissionSchema: planCandidateSubmissionSchema(
      selectableSpecIds,
      priorFindingRefs.map((ref) => ref.id),
    ),
    decode(submission, envelope) {
      const state = requireRecord(envelope.context.stateInput, "Planning state");
      const value = requireRecord(submission, "Planning submission");
      requireLiteral(value.kind, "plan_candidate", "Planning kind");
      const findingDecisions = state.findingSetRef
        ? decodeFindingDecisions(value.findingDecisions, priorFindingRefs)
        : [];
      const candidate = authorPlanningProposal(value, {
        goalContractRef: requireContentRef(state.goalContractRef, "goalContractRef"),
        authorityRef: requireContentRef(state.authorityRef, "authorityRef"),
        requiredOutcomeId: requireString(state.requiredOutcomeId, "requiredOutcomeId"),
        artifactPersistence: requireArtifactPersistence(state.artifactPersistence),
        workspaceScopeRef: requireWorkspaceScope(envelope.context.baselineObservationScopeRefs),
        ledgerId: requireString(state.ledgerId, "ledgerId"),
        ...(optionalString(state.specParentRootId) ? {
          specParentRootId: optionalString(state.specParentRootId),
        } : {}),
        programId: requireString(state.programId, "programId"),
        observedManifestRevision: requirePositiveInteger(
          state.observedManifestRevision,
          "observedManifestRevision",
        ),
        governingSpecRefs: requireContentRefs(state.governingSpecRefs, "governingSpecRefs"),
        availableSpecs: decodeAvailableSpecs(
          state.availableSpecs,
          optionalString(state.specParentRootId),
        ),
        requireGoverningSpec: Boolean(state.requireGoverningSpec),
        ...(state.previousCandidateRef
          ? {
              previousCandidateRef: requireContentRef(
                state.previousCandidateRef,
                "previousCandidateRef",
              ),
            }
          : {}),
        ...(state.findingSetRef
          ? {
              findingSetRef: requireContentRef(state.findingSetRef, "findingSetRef"),
              findingDecisions,
            }
          : {}),
        ...(state.continuation
          ? { continuation: state.continuation as PlanningContinuation }
          : {}),
      });
      if (state.previousPlanCandidate && state.priorPlanningReview) {
        assertRevisedPlanChanged({
          previous: state.previousPlanCandidate as PlanningCandidateProduct["candidate"],
          revised: candidate,
          priorReview: state.priorPlanningReview as PlanningReview,
          decisions: findingDecisions,
        });
      }
      return {
        kind: "plan_candidate",
        candidate,
        observationResultIndex: retainPlanningObservations(
          priorObservationResultIndex(state.priorPlanningObservationResultIndex),
          envelope.operationResults,
        ),
      };
    },
  };
  return applyPlanningDeferralPolicy(codec, deferralPolicy);
}

function priorObservationResultIndex(value: unknown): PlanningObservationResultIndexEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("priorPlanningObservationResultIndex must be an array");
  return value as PlanningObservationResultIndexEntry[];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function proposePlan(
  command: PhaseInvocation,
  deferralPolicy: PlanningDeferralPolicy = "allow",
) {
  const state = requireRecord(command.context.stateInput, "Planning state");
  const availableSpecs = decodeAvailableSpecs(
    state.availableSpecs,
    optionalString(state.specParentRootId),
  );
  const admittedGoverningSpecRefs = requireContentRefs(
    state.governingSpecRefs,
    "governingSpecRefs",
  );
  const priorFindingRefs = requiredSubjectFindingRefs(state.priorPlanningReview);
  return runPhaseConversation({
    ...command,
    phaseContract: CONTRACT,
    codec: planningCodec(
      selectableGoverningSpecIds(availableSpecs, admittedGoverningSpecRefs),
      priorFindingRefs,
      deferralPolicy,
    ),
  });
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

function requireContentRefs(value: unknown, label: string): ContentRef[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => requireContentRef(item, `${label}[${index}]`));
}

function requireArtifactPersistence(value: unknown): "not_required" | "required" {
  if (value !== "not_required" && value !== "required") {
    throw new Error("Planning state has an invalid artifactPersistence");
  }
  return value;
}
