import {
  contentRef,
  requireLiteral,
  requireRecord,
  requireString,
  runPhaseConversation,
  type ContentRef,
  type PhaseContract,
  type PhaseInvocation,
} from "../core/index.ts";
import type { FeedbackIntentProduct } from "../conception/index.ts";
import { PLANNING_AUTHORING_CONTRACTS } from "./authoring-contracts.ts";
import type {
  FeedbackPlanProduct,
  ManagedTask,
  PlanningCandidate,
  PlanningFindingDecision,
} from "./contracts.ts";
import { withManagedDeferral } from "../deferral/index.ts";
import { authorPlanCandidate } from "./plan-graph/index.ts";
import { feedbackPlanSubmissionSchema } from "./submission-schemas.ts";
import { decodeAvailableSpecs } from "./decode-available-specs.ts";
import { decodeTaskImpact } from "./decode-task-impact.ts";
import {
  decodeFindingDecisions,
  requiredFeedbackFindingRefs,
} from "./finding-decisions.ts";
import { decodeCorrectionExecutionRequirement } from "./correction-authority.ts";
import { preserveUnaffectedTaskDrafts } from
  "./plan-revision/preserve-unaffected-tasks.ts";

const CONTRACT: PhaseContract = {
  phase: "feedback_planning",
  operationSurface: "authorized",
  objective: "author_the_exact_review_correction_or_governing_revision",
  duties: [
    "preserve_original_goal", "preserve_selected_model", "state_input_only",
    "author_scoped_correction", "classify_correction_kind",
    "author_complete_impact_map", "apply_authoring_contracts",
    "author_artifact_lifecycle", "candidate_revision_lineage",
    "apply_exact_review_findings",
    "author_managed_deferral",
  ],
  prohibitions: [
    "no_successor_choice", "no_runtime_semantic_judgment", "no_model_substitution",
    "no_heuristic_route", "no_generic_assurance_layer", "no_hidden_retry_loop",
    "no_mutation", "no_self_review",
  ],
  authoringContractRefs: PLANNING_AUTHORING_CONTRACTS.map((contract) => contract.contractId),
  authoringContracts: PLANNING_AUTHORING_CONTRACTS,
};

function feedbackPlanningCodec(
  availableSpecIds: string[],
  correctionKind: FeedbackIntentProduct["feedbackIntent"]["correctionKind"],
  priorFindingRefs: ContentRef[],
) {
  return withManagedDeferral<FeedbackPlanProduct>({
    submissionSchema: feedbackPlanSubmissionSchema(
      availableSpecIds,
      correctionKind,
      priorFindingRefs.map((ref) => ref.id),
    ),
    decode(submission, envelope) {
      const state = requireRecord(envelope.context.stateInput, "Feedback Planning state");
      const intent = state.feedbackIntent as FeedbackIntentProduct | undefined;
      if (intent?.kind !== "feedback_intent") {
        throw new Error("Feedback Planning is missing its accepted intent");
      }
      const value = requireRecord(submission, "Feedback Planning submission");
      requireLiteral(value.kind, "feedback_plan_candidate", "Feedback Planning kind");
      if (value.correctionKind !== intent.feedbackIntent.correctionKind) {
        throw new Error("Feedback Planning changed the accepted correction kind");
      }
      const currentPlanRef = requireContentRef(state.workPlanRef, "workPlanRef");
      const affectedTaskRefs = requireContentRefs(state.affectedTaskRefs, "affectedTaskRefs");
      const lifecycleRef = requireContentRef(state.artifactLifecycleRef, "artifactLifecycleRef");
      const revisionOrigin = revisionOriginFrom(
        state,
        decodeFindingDecisions(
          value.findingDecisions,
          priorFindingRefs,
          "Feedback Planning",
        ),
      );
      if (value.correctionKind === "implementation_repair") {
        const correctionPlan = correctionPlanFor(
          currentPlanRef,
          affectedTaskRefs,
          lifecycleRef,
          value.correctionAction,
          value.executionRequirement,
          intent.feedbackIntent.findingDecisions,
        );
        return feedbackProduct({
          correctionKind: "implementation_repair",
          revisionOrigin,
          feedbackIntentRef: intent.feedbackIntent.ref,
          correctionScopeRef: intent.feedbackIntent.correctionScopeRef,
          correctionPlan,
        });
      }

      const currentAuthorityRef = requireContentRef(state.authorityRef, "authorityRef");
      const proposedAuthority = value.correctionKind === "authority_scope_revision"
        ? authorityRevision(currentAuthorityRef, value.authorityChange)
        : undefined;
      const acceptedPlan = requirePlanningCandidate(state.acceptedPlan);
      const revisedPlan = authorPlanCandidate(
        preserveUnaffectedTaskDrafts({
          revisedPlan: requireRecord(value.revisedPlan, "revisedPlan"),
          impactMap: value.impactMap,
          acceptedPlan,
        }),
        {
          ledgerId: requireString(state.ledgerId, "ledgerId"),
          programId: requireString(state.programId, "programId"),
          observedManifestRevision: requirePositiveInteger(
            state.observedManifestRevision,
            "observedManifestRevision",
          ),
          goalContractRef: requireContentRef(state.goalContractRef, "goalContractRef"),
          authorityRef: proposedAuthority?.ref ?? currentAuthorityRef,
          governingSpecRefs: requireContentRefArray(state.governingSpecRefs, "governingSpecRefs"),
          availableSpecs: decodeAvailableSpecs(
            state.availableSpecs,
            optionalString(state.specParentRootId),
          ),
          ...(optionalString(state.specParentRootId) ? {
            specParentRootId: optionalString(state.specParentRootId),
          } : {}),
          requireGoverningSpec: Boolean(state.requireGoverningSpec),
          requiredOutcomeId: requireString(state.requiredOutcomeId, "requiredOutcomeId"),
          artifactPersistence: requireArtifactPersistence(state.artifactPersistence),
          workspaceScopeRef: requireWorkspaceScope(envelope.context.baselineObservationScopeRefs),
        },
      );
      const impactMap = decodeTaskImpact({
        submission: value.impactMap,
        currentTasks: requireTaskImpactIndex(state.taskImpactIndex),
        nextTasks: revisedPlan.tasks,
      });
      const revisedTargets = impactMap
        .filter((impact) => impact.disposition !== "unaffected")
        .map((impact) => impact.priorTaskRef);
      if (revisedTargets.length === 0) {
        throw new Error("Governing revision must identify at least one affected Task");
      }
      const correctionPlan = correctionPlanFor(
        revisedPlan.plan.ref,
        revisedTargets as [ContentRef, ...ContentRef[]],
        revisedPlan.artifactLifecycle.ref,
        value.correctionAction,
        value.executionRequirement,
        intent.feedbackIntent.findingDecisions,
      );
      const common = {
        revisionOrigin,
        feedbackIntentRef: intent.feedbackIntent.ref,
        correctionScopeRef: intent.feedbackIntent.correctionScopeRef,
        correctionPlan,
        impactMap,
        nextPlanCandidate: revisedPlan,
      };
      if (value.correctionKind === "governing_revision") {
        return feedbackProduct({ ...common, correctionKind: "governing_revision" });
      }
      return feedbackProduct({
        ...common,
        correctionKind: "authority_scope_revision",
        proposedAuthority: proposedAuthority!,
      });
    },
  });
}

export function proposeCorrectionOrRevision(command: PhaseInvocation) {
  const state = requireRecord(command.context.stateInput, "Feedback Planning state");
  const intent = state.feedbackIntent as FeedbackIntentProduct | undefined;
  if (intent?.kind !== "feedback_intent") {
    throw new Error("Feedback Planning is missing its accepted intent");
  }
  const correctionKind = intent.feedbackIntent.correctionKind;
  const availableSpecs = correctionKind === "implementation_repair"
    ? []
    : decodeAvailableSpecs(state.availableSpecs, optionalString(state.specParentRootId));
  const priorFindingRefs = requiredFeedbackFindingRefs(
    state.previousFeedbackPlanningReview,
  );
  return runPhaseConversation({
    ...command,
    phaseContract: CONTRACT,
    codec: feedbackPlanningCodec(
      availableSpecs.map((spec) => spec.logicalId),
      correctionKind,
      priorFindingRefs,
    ),
  });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireWorkspaceScope(scopeRefs: readonly string[]): string {
  const workspaceScopeRef = scopeRefs.find((scopeRef) => scopeRef.startsWith("workspace:"));
  if (!workspaceScopeRef) throw new Error("Feedback Planning requires an admitted workspace scope");
  return workspaceScopeRef;
}

function requireArtifactPersistence(value: unknown): "not_required" | "required" {
  if (value !== "not_required" && value !== "required") {
    throw new Error("Feedback Planning state has an invalid artifactPersistence");
  }
  return value;
}

function authorityRevision(previousAuthorityRef: ContentRef, change: unknown) {
  const body = {
    previousAuthorityRef,
    change: requireString(change, "authorityChange"),
  };
  return { ref: contentRef("authority-revision", body), ...body };
}

function correctionPlanFor(
  governingWorkPlanRef: ContentRef,
  targetTaskRefs: [ContentRef, ...ContentRef[]],
  artifactLifecycleRef: ContentRef,
  action: unknown,
  executionRequirement: unknown,
  findingDecisions: PlanningFindingDecision[],
) {
  const body = {
    kind: "correction_plan" as const,
    governingWorkPlanRef,
    targetTaskRefs,
    correctionAction: requireString(action, "correctionAction"),
    executionRequirement: decodeCorrectionExecutionRequirement(executionRequirement),
    findingDecisions,
    artifactLifecycleRef,
  };
  return { ref: contentRef("correction-plan", body), ...body };
}

function feedbackProduct(
  candidateBody: Omit<FeedbackPlanProduct["candidate"], "ref">,
): FeedbackPlanProduct {
  return {
    kind: "feedback_plan_candidate",
    candidate: { ref: contentRef("feedback-plan-candidate", candidateBody), ...candidateBody },
  } as FeedbackPlanProduct;
}

function revisionOriginFrom(
  state: Record<string, unknown>,
  findingDecisions: PlanningFindingDecision[],
) {
  return state.previousCandidateRef && state.findingSetRef
    ? {
        kind: "review_revision" as const,
        previousCandidateRef: requireContentRef(state.previousCandidateRef, "previousCandidateRef"),
        findingSetRef: requireContentRef(state.findingSetRef, "findingSetRef"),
        findingDecisions,
      }
    : { kind: "initial" as const };
}

function requireTaskImpactIndex(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("taskImpactIndex is empty");
  return value as Array<{
    task: Pick<ManagedTask, "ref" | "taskLogicalId">;
    status: string;
    hasCurrentResult: boolean;
  }>;
}

function requirePlanningCandidate(value: unknown): PlanningCandidate {
  const candidate = requireRecord(value, "acceptedPlan") as unknown as PlanningCandidate;
  if (!Array.isArray(candidate.tasks) || !Array.isArray(candidate.works)) {
    throw new Error("Feedback Planning acceptedPlan is incomplete");
  }
  return candidate;
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

function requireContentRefs(value: unknown, label: string): [ContentRef, ...ContentRef[]] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} is empty`);
  return value.map((item, index) =>
    requireContentRef(item, `${label}[${index}]`)) as [ContentRef, ...ContentRef[]];
}

function requireContentRefArray(value: unknown, label: string): ContentRef[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => requireContentRef(item, `${label}[${index}]`));
}
