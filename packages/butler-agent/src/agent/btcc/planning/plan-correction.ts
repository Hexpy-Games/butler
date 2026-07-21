import {
  contentRef,
  requireLiteral,
  requireRecord,
  requireString,
  runPhaseConversation,
  stableJson,
  type ContentRef,
  type PhaseCodec,
  type PhaseContract,
  type PhaseInvocation,
} from "../core/index.ts";
import type { FeedbackIntentProduct } from "../conception/index.ts";
import { PLANNING_AUTHORING_CONTRACTS } from "./authoring-contracts.ts";
import type {
  FeedbackPlanProduct,
  ManagedTask,
  TaskImpact,
} from "./contracts.ts";
import { authorPlanCandidate } from "./plan-graph/index.ts";

const CONTRACT: PhaseContract = {
  phase: "feedback_planning",
  objective: "author_the_exact_review_correction_or_governing_revision",
  duties: [
    "preserve_original_goal", "preserve_selected_model", "state_input_only",
    "author_scoped_correction", "classify_correction_kind",
    "author_complete_impact_map", "apply_authoring_contracts",
    "author_artifact_lifecycle", "candidate_revision_lineage",
  ],
  prohibitions: [
    "no_successor_choice", "no_runtime_semantic_judgment", "no_model_substitution",
    "no_heuristic_route", "no_generic_evidence", "no_hidden_retry_loop",
    "no_mutation", "no_self_review", "no_implicit_prior_task_invalidation",
  ],
  authoringContractRefs: PLANNING_AUTHORING_CONTRACTS.map((contract) => contract.contractId),
  authoringContracts: PLANNING_AUTHORING_CONTRACTS,
};

const codec: PhaseCodec<FeedbackPlanProduct> = {
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
    const taskRef = requireContentRef(state.taskRef, "taskRef");
    const lifecycleRef = requireContentRef(state.artifactLifecycleRef, "artifactLifecycleRef");
    const revisionOrigin = revisionOriginFrom(state);
    if (value.correctionKind === "implementation_repair") {
      const correctionPlan = correctionPlanFor(
        currentPlanRef,
        taskRef,
        lifecycleRef,
        value.correctionAction,
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
    const revisedPlan = authorPlanCandidate(
      requireRecord(value.revisedPlan, "revisedPlan"),
      {
        ledgerId: requireString(state.ledgerId, "ledgerId"),
        programId: requireString(state.programId, "programId"),
        observedManifestRevision: requirePositiveInteger(
          state.observedManifestRevision,
          "observedManifestRevision",
        ),
        goalContractRef: requireContentRef(state.goalContractRef, "goalContractRef"),
        authorityRef: proposedAuthority?.ref ?? currentAuthorityRef,
        requiredOutcomeId: requireString(state.requiredOutcomeId, "requiredOutcomeId"),
      },
    );
    const currentTasks = requireManagedTasks(state.currentTasks);
    const impactMap = decodeImpactMap(value.impactMap, currentTasks, revisedPlan.tasks);
    const correctionPlan = correctionPlanFor(
      revisedPlan.plan.ref,
      taskRef,
      revisedPlan.artifactLifecycle.ref,
      value.correctionAction,
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
};

export function proposeCorrectionOrRevision(command: PhaseInvocation) {
  return runPhaseConversation({ ...command, phaseContract: CONTRACT, codec });
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
  targetTaskRef: ContentRef,
  artifactLifecycleRef: ContentRef,
  action: unknown,
) {
  const body = {
    kind: "correction_plan" as const,
    governingWorkPlanRef,
    targetTaskRef,
    correctionAction: requireString(action, "correctionAction"),
    artifactLifecycleRef,
  };
  return { ref: contentRef("correction-plan", body), ...body };
}

function decodeImpactMap(
  value: unknown,
  currentTasks: ManagedTask[],
  nextTasks: ManagedTask[],
): TaskImpact[] {
  if (!Array.isArray(value) || value.length !== currentTasks.length) {
    throw new Error("Feedback Planning impact map must cover every current Task");
  }
  return value.map((item, index) => {
    const impact = requireRecord(item, `impactMap[${index}]`);
    const priorTask = currentTasks[index]!;
    if (stableJson(impact.priorTaskRef) !== stableJson(priorTask.ref)) {
      throw new Error("Feedback Planning impact map changed Task order");
    }
    const disposition = impact.disposition;
    if (
      disposition !== "unaffected" && disposition !== "revalidate" &&
      disposition !== "rework" && disposition !== "replan"
    ) {
      throw new Error("Feedback Planning impact disposition is invalid");
    }
    const successor = nextTasks.find((task) => task.taskLogicalId === priorTask.taskLogicalId);
    return {
      priorTaskRef: priorTask.ref,
      disposition,
      ...(successor ? { successorTaskRef: successor.ref } : {}),
    };
  });
}

function feedbackProduct(
  candidateBody: Omit<FeedbackPlanProduct["candidate"], "ref">,
): FeedbackPlanProduct {
  return {
    kind: "feedback_plan_candidate",
    candidate: { ref: contentRef("feedback-plan-candidate", candidateBody), ...candidateBody },
  } as FeedbackPlanProduct;
}

function revisionOriginFrom(state: Record<string, unknown>) {
  return state.previousCandidateRef && state.findingSetRef
    ? {
        kind: "review_revision" as const,
        previousCandidateRef: requireContentRef(state.previousCandidateRef, "previousCandidateRef"),
        findingSetRef: requireContentRef(state.findingSetRef, "findingSetRef"),
      }
    : { kind: "initial" as const };
}

function requireManagedTasks(value: unknown): ManagedTask[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("currentTasks is empty");
  return value as ManagedTask[];
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
