import {
  contentRef,
  requireString,
  type ContentRef,
} from "../../core/index.ts";
import type { GoalArtifactPersistence } from "../../conception/index.ts";
import type {
  ManagedCriterion,
  ManagedTask,
  ManagedVerificationQuestion,
  ManagedWork,
  PlanningCandidate,
} from "../contracts.ts";
import { planningCandidateBundleEntries } from "../candidate-bundle.ts";
import { authorArtifactLifecycle } from "./author-artifact-lifecycle.ts";
import { authorGoverningSpecs } from "./author-governing-specs.ts";
import { authorPlanningConsiderations } from "./author-planning-considerations.ts";
import {
  owningWork,
  readWorkDrafts,
  validateGraph,
  type TaskDraft,
  type WorkDraft,
} from "./read-plan-drafts.ts";
import { rejectPlanningProposal } from "./planning-proposal-defect.ts";
import { resumeStoppedAcceptedPlan } from "./resume-stopped-accepted-plan.ts";
import { validateArtifactPersistence } from "./validate-artifact-persistence.ts";

export type AuthoringState = {
  ledgerId: string;
  programId: string;
  observedManifestRevision: number;
  goalContractRef: ContentRef;
  authorityRef: ContentRef;
  governingSpecRefs: ContentRef[];
  availableSpecs?: import("../contracts.ts").AvailableSpecRevision[];
  requiredOutcomeId: string;
  artifactPersistence: GoalArtifactPersistence;
  workspaceScopeRef: string;
  previousCandidateRef?: ContentRef;
  findingSetRef?: ContentRef;
  findingDecisions?: import("../contracts.ts").PlanningFindingDecision[];
  continuation?: import("../contracts.ts").PlanningContinuation;
  requireGoverningSpec?: boolean;
  specParentRootId?: string;
  preservedPlan?: PlanningCandidate;
  preservedTaskLogicalIds?: string[];
};

export function authorPlanCandidate(
  submission: Record<string, unknown>,
  state: AuthoringState,
): PlanningCandidate {
  const resumed = resumeStoppedAcceptedPlan(submission, state);
  if (resumed) return resumed;
  const { authoredSpecs, governingSpecRefs } = authorGoverningSpecs(
    submission.specifications,
    submission.governingSpecSelections,
    state.availableSpecs ?? [],
    state.governingSpecRefs,
    state.specParentRootId,
  );
  if (state.requireGoverningSpec && governingSpecRefs.length === 0) {
    rejectPlanningProposal(
      "governing_spec_missing",
      "Project Planning must reuse or author a governing Spec revision",
    );
  }
  state = { ...state, governingSpecRefs };
  const drafts = readWorkDrafts(
    submission.works,
    state.workspaceScopeRef,
  );
  const orderedTasks = drafts.flatMap((work) => work.tasks)
    .sort((left, right) => left.executionOrdinal - right.executionOrdinal);
  validateGraph(drafts, orderedTasks, state.requiredOutcomeId);

  const criteria: ManagedCriterion[] = [];
  const questions: ManagedVerificationQuestion[] = [];
  const taskRefs = new Map<string, ContentRef>();
  const tasks: ManagedTask[] = [];

  for (const draft of orderedTasks) {
    const preserved = preservedTask(draft, drafts, taskRefs, state);
    if (preserved) {
      appendPreservedTaskRecords(preserved, state.preservedPlan!, criteria, questions);
      taskRefs.set(draft.logicalId, preserved.ref);
      tasks.push(preserved);
      continue;
    }
    const taskCriteria = materializeCriteria(draft, state, criteria, questions);
    const taskBody = {
      taskLogicalId: draft.logicalId,
      displayTitle: draft.displayTitle,
      programId: state.programId,
      workLogicalId: owningWork(drafts, draft.logicalId).logicalId,
      goalContractRef: state.goalContractRef,
      governingSpecRefs: state.governingSpecRefs,
      intendedOutcome: draft.intendedOutcome,
      executionOrdinal: draft.executionOrdinal,
      dependencyTaskRefs: draft.dependencyTaskIds.map((id) => requiredRef(taskRefs, id, "Task")),
      effectClass: draft.effectClass,
      targetScopeRefs: draft.targetScopeRefs,
      artifactPolicy: draft.artifactPolicy ?? {
        kind: "non_artifact" as const, targetScopeRefs: draft.targetScopeRefs,
      },
      criterionRefs: taskCriteria.criteria.map((criterion) => criterion.ref),
      verificationQuestionRefs: taskCriteria.questions.map((question) => question.ref),
    };
    const task = { ref: contentRef("task", taskBody), ...taskBody };
    taskRefs.set(draft.logicalId, task.ref);
    tasks.push(task);
  }

  const works = materializeWorks(drafts, tasks, state);
  const authoredLifecycle = authorArtifactLifecycle(submission, tasks, {
    programId: state.programId,
    requiredOutcomeId: state.requiredOutcomeId,
    authorityRef: state.authorityRef,
  });
  const artifactLifecycle = authoredLifecycle.lifecycle;
  validateArtifactPersistence(state.artifactPersistence, artifactLifecycle);
  const { risks, assumptions } = authorPlanningConsiderations(
    submission,
    tasks,
    state.programId,
  );
  const dependencyEdges = tasks.flatMap((task) => task.dependencyTaskRefs.map((predecessorTaskRef) => ({
    predecessorTaskRef,
    successorTaskRef: task.ref,
  })));
  const graphBody = {
    programId: state.programId,
    workRefs: works.map((work) => work.ref),
    taskRefs: tasks.map((task) => task.ref),
    integrationCriterionRefs: authoredLifecycle.integrationCriteria.map((item) => item.ref),
    effectIntentRefs: authoredLifecycle.effectIntents.map((item) => item.ref),
    dependencyEdges,
  };
  const workGraph = { ref: contentRef("work-graph", graphBody), ...graphBody };
  const planBody = {
    programId: state.programId,
    goalContractRef: state.goalContractRef,
    governingSpecRefs: state.governingSpecRefs,
    strategy: requireString(submission.strategy, "strategy"),
    workGraphRef: workGraph.ref,
    workRefs: works.map((work) => work.ref),
    taskRefs: tasks.map((task) => task.ref),
    criterionRefs: criteria.map((criterion) => criterion.ref),
    verificationQuestionRefs: questions.map((question) => question.ref),
    integrationCriterionRefs: authoredLifecycle.integrationCriteria.map((item) => item.ref),
    effectIntentRefs: authoredLifecycle.effectIntents.map((item) => item.ref),
    riskRefs: risks.map((item) => item.ref),
    assumptionRefs: assumptions.map((item) => item.ref),
    artifactLifecycleRef: artifactLifecycle.ref,
  };
  const plan = { ref: contentRef("work-plan", planBody), ...planBody };
  const entries = planningCandidateBundleEntries({
    authoredSpecs,
    criteria,
    verificationQuestions: questions,
    effectIntents: authoredLifecycle.effectIntents,
    integrationCriteria: authoredLifecycle.integrationCriteria,
    risks,
    assumptions,
    tasks,
    works,
    artifactLifecycle,
    workGraph,
    plan,
  });
  const bundleBody = {
    ledgerId: state.ledgerId,
    programId: state.programId,
    observedManifestRevision: state.observedManifestRevision,
    recordRefs: entries.map((entry) => entry.ref),
  };
  const bundle = { ref: contentRef("planning-candidate-bundle", bundleBody), ...bundleBody };
  const revisionOrigin = state.continuation?.kind === "deferred_goal"
    ? {
        kind: "deferred_continuation" as const,
        continuationBindingRef: state.continuation.ref,
        sourceTurnId: state.continuation.sourceTurnId,
        deferredAnchorRef: state.continuation.anchorRef,
      }
    : state.continuation?.kind === "stopped_program"
      ? {
          kind: "stopped_continuation" as const,
          continuationBindingRef: state.continuation.ref,
          sourceTurnId: state.continuation.sourceTurnId,
          stoppedAnchorRef: state.continuation.anchorRef,
          ...stoppedTaskProvenance(state.continuation),
        }
      : { kind: "initial" as const };
  const reviewRevision = state.previousCandidateRef && state.findingSetRef
    ? {
        previousCandidateRef: state.previousCandidateRef,
        findingSetRef: state.findingSetRef,
        findingDecisions: state.findingDecisions ?? [],
      }
    : undefined;
  const candidateBody = {
    ledgerId: state.ledgerId,
    programId: state.programId,
    observedManifestRevision: state.observedManifestRevision,
    goalContractRef: state.goalContractRef,
    governingSpecRefs: state.governingSpecRefs,
    authoredSpecRevisionRefs: authoredSpecs.map((spec) => spec.ref),
    authoredSpecs,
    authorityRef: state.authorityRef,
    revisionOrigin,
    ...(reviewRevision ? { reviewRevision } : {}),
    resolvedDeferralAnchorRefs: state.continuation?.kind === "deferred_goal"
      ? [state.continuation.anchorRef]
      : [],
    plan,
    works,
    tasks,
    criteria,
    verificationQuestions: questions,
    integrationCriteria: authoredLifecycle.integrationCriteria,
    effectIntents: authoredLifecycle.effectIntents,
    risks,
    assumptions,
    workGraph,
    artifactLifecycle,
    bundle,
  };
  return { ref: contentRef("plan-candidate", candidateBody), ...candidateBody };
}

function preservedTask(
  draft: TaskDraft,
  drafts: WorkDraft[],
  taskRefs: Map<string, ContentRef>,
  state: AuthoringState,
): ManagedTask | undefined {
  if (!state.preservedTaskLogicalIds?.includes(draft.logicalId)) return undefined;
  const task = state.preservedPlan?.tasks.find(
    (candidate) => candidate.taskLogicalId === draft.logicalId,
  );
  if (!task) throw new Error(`Preserved Task is absent from the accepted Plan: ${draft.logicalId}`);
  if (
    task.workLogicalId !== owningWork(drafts, draft.logicalId).logicalId ||
    task.executionOrdinal !== draft.executionOrdinal
  ) {
    throw new Error(`Unaffected Task topology changed: ${draft.logicalId}`);
  }
  const dependencyRefs = draft.dependencyTaskIds.map((id) => requiredRef(taskRefs, id, "Task"));
  if (!sameRefs(dependencyRefs, task.dependencyTaskRefs)) {
    throw new Error(`Unaffected Task dependencies changed: ${draft.logicalId}`);
  }
  return task;
}

function appendPreservedTaskRecords(
  task: ManagedTask,
  plan: PlanningCandidate,
  criteria: ManagedCriterion[],
  questions: ManagedVerificationQuestion[],
): void {
  for (const ref of task.criterionRefs) {
    criteria.push(requiredRecord(plan.criteria, ref, "criterion"));
  }
  for (const ref of task.verificationQuestionRefs) {
    questions.push(requiredRecord(plan.verificationQuestions, ref, "verification question"));
  }
}

function requiredRecord<T extends { ref: ContentRef }>(
  records: T[],
  ref: ContentRef,
  kind: string,
): T {
  const record = records.find((candidate) => sameRef(candidate.ref, ref));
  if (!record) throw new Error(`Accepted Plan is missing preserved ${kind}: ${ref.id}`);
  return record;
}

function sameRefs(left: ContentRef[], right: ContentRef[]): boolean {
  return left.length === right.length && left.every((ref, index) => sameRef(ref, right[index]!));
}

function sameRef(left: ContentRef, right: ContentRef): boolean {
  return left.id === right.id && left.sha256 === right.sha256;
}

function stoppedTaskProvenance(
  continuation: Extract<NonNullable<AuthoringState["continuation"]>, { kind: "stopped_program" }>,
): { stoppedTaskRef?: ContentRef; stoppedResultRef?: ContentRef; stoppedReviewRef?: ContentRef } {
  const interrupted = continuation.context?.frontier.interruptedTask;
  if (!interrupted) return {};
  return {
    stoppedTaskRef: interrupted.task.ref,
    ...(interrupted.resultRef ? { stoppedResultRef: interrupted.resultRef } : {}),
    ...(interrupted.reviewRef ? { stoppedReviewRef: interrupted.reviewRef } : {}),
  };
}

function materializeCriteria(
  task: TaskDraft,
  state: AuthoringState,
  allCriteria: ManagedCriterion[],
  allQuestions: ManagedVerificationQuestion[],
) {
  const criteria = task.criteria.map((draft, ordinal) => {
    const body = {
      ordinal,
      taskLogicalId: task.logicalId,
      statement: draft.statement,
      sourceGoalFieldIds: draft.sourceGoalFieldIds,
      sourceRequiredOutcomeRefs: draft.sourceRequiredOutcomeRefs,
    };
    return { ref: contentRef("acceptance-criterion", body), ...body };
  });
  const questions = criteria.map((criterion, ordinal) => {
    const body = { criterionRef: criterion.ref, question: task.criteria[ordinal]!.question };
    return { ref: contentRef("verification-question", body), ...body };
  });
  allCriteria.push(...criteria);
  allQuestions.push(...questions);
  return { criteria, questions };
}

function materializeWorks(
  drafts: WorkDraft[],
  tasks: ManagedTask[],
  state: AuthoringState,
): ManagedWork[] {
  const refs = new Map<string, ContentRef>();
  return drafts.map((draft) => {
    const body = {
      workLogicalId: draft.logicalId,
      programId: state.programId,
      goalContractRef: state.goalContractRef,
      governingSpecRefs: state.governingSpecRefs,
      outcome: draft.outcome,
      dependencyWorkRefs: draft.dependencyWorkIds.map((id) => requiredRef(refs, id, "Work")),
      taskRefs: tasks.filter((task) => task.workLogicalId === draft.logicalId).map((task) => task.ref),
    };
    const work = { ref: contentRef("work", body), ...body };
    refs.set(draft.logicalId, work.ref);
    return work;
  });
}

function requiredRef(refs: Map<string, ContentRef>, id: string, kind: string): ContentRef {
  const ref = refs.get(id);
  if (!ref) {
    rejectPlanningProposal(
      "dependency_not_materialized",
      `${kind} dependency is not materialized: ${id}`,
    );
  }
  return ref;
}
