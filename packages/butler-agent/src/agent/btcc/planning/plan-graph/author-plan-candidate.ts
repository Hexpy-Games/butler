import {
  contentRef,
  requireRecord,
  requireString,
  requireStringArray,
  type ContentRef,
} from "../../core/index.ts";
import type {
  ManagedCriterion,
  ManagedTask,
  ManagedVerificationQuestion,
  ManagedWork,
  PlanningCandidate,
} from "../contracts.ts";

type AuthoringState = {
  ledgerId: string;
  programId: string;
  observedManifestRevision: number;
  goalContractRef: ContentRef;
  authorityRef: ContentRef;
  requiredOutcomeId: string;
  previousCandidateRef?: ContentRef;
  findingSetRef?: ContentRef;
};

type TaskDraft = {
  logicalId: string;
  intendedOutcome: string;
  executionOrdinal: number;
  dependencyTaskIds: string[];
  targetScopeRefs: string[];
  criteria: CriterionDraft[];
};

type CriterionDraft = {
  statement: string;
  question: string;
  sourceGoalFieldIds: Array<"request" | "intended_result">;
  sourceRequiredOutcomeRefs: string[];
};

type WorkDraft = {
  logicalId: string;
  outcome: string;
  dependencyWorkIds: string[];
  tasks: TaskDraft[];
};

export function authorPlanCandidate(
  submission: Record<string, unknown>,
  state: AuthoringState,
): PlanningCandidate {
  const drafts = readWorkDrafts(submission.works);
  const orderedTasks = drafts.flatMap((work) => work.tasks)
    .sort((left, right) => left.executionOrdinal - right.executionOrdinal);
  validateGraph(drafts, orderedTasks, state.requiredOutcomeId);

  const criteria: ManagedCriterion[] = [];
  const questions: ManagedVerificationQuestion[] = [];
  const taskRefs = new Map<string, ContentRef>();
  const tasks: ManagedTask[] = [];

  for (const draft of orderedTasks) {
    const taskCriteria = materializeCriteria(draft, state, criteria, questions);
    const taskBody = {
      taskLogicalId: draft.logicalId,
      programId: state.programId,
      workLogicalId: owningWork(drafts, draft.logicalId).logicalId,
      goalContractRef: state.goalContractRef,
      intendedOutcome: draft.intendedOutcome,
      executionOrdinal: draft.executionOrdinal,
      dependencyTaskRefs: draft.dependencyTaskIds.map((id) => requiredRef(taskRefs, id, "Task")),
      artifactPolicy: {
        kind: "non_artifact" as const,
        targetScopeRefs: draft.targetScopeRefs,
      },
      criterionRefs: taskCriteria.criteria.map((criterion) => criterion.ref),
      verificationQuestionRefs: taskCriteria.questions.map((question) => question.ref),
    };
    const task = { ref: contentRef("task", taskBody), ...taskBody };
    taskRefs.set(draft.logicalId, task.ref);
    tasks.push(task);
  }

  const works = materializeWorks(drafts, tasks, state);
  const dependencyEdges = tasks.flatMap((task) => task.dependencyTaskRefs.map((predecessorTaskRef) => ({
    predecessorTaskRef,
    successorTaskRef: task.ref,
  })));
  const graphBody = {
    programId: state.programId,
    workRefs: works.map((work) => work.ref),
    taskRefs: tasks.map((task) => task.ref),
    dependencyEdges,
  };
  const workGraph = { ref: contentRef("work-graph", graphBody), ...graphBody };
  const lifecycleBody = {
    programId: state.programId,
    taskPolicies: tasks.map((task) => ({ taskRef: task.ref, policy: task.artifactPolicy })),
    promotionSelectors: [] as [],
    promotionTaskRefs: [] as [],
    effectIntentRefs: [] as [],
    integrationCriteria: [] as [],
    promotionProtocol: "not_applicable" as const,
  };
  const artifactLifecycle = {
    ref: contentRef("artifact-lifecycle", lifecycleBody), ...lifecycleBody,
  };
  const planBody = {
    programId: state.programId,
    goalContractRef: state.goalContractRef,
    strategy: requireString(submission.strategy, "strategy"),
    workGraphRef: workGraph.ref,
    workRefs: works.map((work) => work.ref),
    taskRefs: tasks.map((task) => task.ref),
    criterionRefs: criteria.map((criterion) => criterion.ref),
    verificationQuestionRefs: questions.map((question) => question.ref),
    artifactLifecycleRef: artifactLifecycle.ref,
  };
  const plan = { ref: contentRef("work-plan", planBody), ...planBody };
  const recordRefs = [
    ...criteria.map((record) => record.ref),
    ...questions.map((record) => record.ref),
    ...tasks.map((record) => record.ref),
    ...works.map((record) => record.ref),
    artifactLifecycle.ref,
    workGraph.ref,
    plan.ref,
  ];
  const bundle = {
    ref: contentRef("planning-candidate-bundle", {
      ledgerId: state.ledgerId,
      programId: state.programId,
      observedManifestRevision: state.observedManifestRevision,
      recordRefs,
    }),
    recordRefs,
  };
  const revisionOrigin = state.previousCandidateRef && state.findingSetRef
    ? {
        kind: "review_revision" as const,
        previousCandidateRef: state.previousCandidateRef,
        findingSetRef: state.findingSetRef,
      }
    : { kind: "initial" as const };
  const candidateBody = {
    ledgerId: state.ledgerId,
    programId: state.programId,
    observedManifestRevision: state.observedManifestRevision,
    goalContractRef: state.goalContractRef,
    authorityRef: state.authorityRef,
    revisionOrigin,
    plan,
    works,
    tasks,
    criteria,
    verificationQuestions: questions,
    workGraph,
    artifactLifecycle,
    bundle,
  };
  return { ref: contentRef("plan-candidate", candidateBody), ...candidateBody };
}

function materializeCriteria(
  task: TaskDraft,
  state: AuthoringState,
  allCriteria: ManagedCriterion[],
  allQuestions: ManagedVerificationQuestion[],
) {
  const criteria = task.criteria.map((draft, ordinal) => {
    const body = {
      taskLogicalId: task.logicalId,
      statement: draft.statement,
      sourceGoalFieldIds: draft.sourceGoalFieldIds,
      sourceRequiredOutcomeRefs: draft.sourceRequiredOutcomeRefs,
    };
    return { ref: contentRef("acceptance-criterion", { ...body, ordinal }), ...body };
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
      outcome: draft.outcome,
      dependencyWorkRefs: draft.dependencyWorkIds.map((id) => requiredRef(refs, id, "Work")),
      taskRefs: tasks.filter((task) => task.workLogicalId === draft.logicalId).map((task) => task.ref),
    };
    const work = { ref: contentRef("work", body), ...body };
    refs.set(draft.logicalId, work.ref);
    return work;
  });
}

function readWorkDrafts(value: unknown): WorkDraft[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Planning requires Works");
  return value.map((item, workIndex) => {
    const work = requireRecord(item, `works[${workIndex}]`);
    const tasks = work.tasks;
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new Error(`works[${workIndex}] requires Tasks`);
    }
    return {
      logicalId: requireString(work.logicalId, `works[${workIndex}].logicalId`),
      outcome: requireString(work.outcome, `works[${workIndex}].outcome`),
      dependencyWorkIds: requireStringArray(work.dependencyWorkIds, "dependencyWorkIds"),
      tasks: tasks.map((item, taskIndex) => readTaskDraft(item, workIndex, taskIndex)),
    };
  });
}

function readTaskDraft(value: unknown, workIndex: number, taskIndex: number): TaskDraft {
  const label = `works[${workIndex}].tasks[${taskIndex}]`;
  const task = requireRecord(value, label);
  const criteria = task.criteria;
  if (!Array.isArray(criteria) || criteria.length === 0) throw new Error(`${label} requires criteria`);
  const executionOrdinal = task.executionOrdinal;
  if (!Number.isInteger(executionOrdinal) || Number(executionOrdinal) < 1) {
    throw new Error(`${label}.executionOrdinal must be a positive integer`);
  }
  return {
    logicalId: requireString(task.logicalId, `${label}.logicalId`),
    intendedOutcome: requireString(task.intendedOutcome, `${label}.intendedOutcome`),
    executionOrdinal: Number(executionOrdinal),
    dependencyTaskIds: requireStringArray(task.dependencyTaskIds, "dependencyTaskIds"),
    targetScopeRefs: requireStringArray(task.targetScopeRefs, "targetScopeRefs"),
    criteria: criteria.map((item, criterionIndex) => {
      const criterion = requireRecord(item, `${label}.criteria[${criterionIndex}]`);
      const fields = requireStringArray(criterion.sourceGoalFieldIds, "sourceGoalFieldIds");
      if (fields.some((field) => field !== "request" && field !== "intended_result")) {
        throw new Error("Planning criterion references an unknown Goal field");
      }
      return {
        statement: requireString(criterion.statement, "criterion.statement"),
        question: requireString(criterion.question, "criterion.question"),
        sourceGoalFieldIds: fields as Array<"request" | "intended_result">,
        sourceRequiredOutcomeRefs: requireStringArray(
          criterion.sourceRequiredOutcomeRefs,
          "sourceRequiredOutcomeRefs",
        ),
      };
    }),
  };
}

function validateGraph(drafts: WorkDraft[], tasks: TaskDraft[], requiredOutcomeId: string): void {
  assertUnique(drafts.map((work) => work.logicalId), "Work logical id");
  assertUnique(tasks.map((task) => task.logicalId), "Task logical id");
  assertUnique(tasks.map((task) => String(task.executionOrdinal)), "Task execution ordinal");
  const workIds = new Set<string>();
  for (const work of drafts) {
    if (work.dependencyWorkIds.some((id) => !workIds.has(id))) {
      throw new Error("Work dependencies must name an earlier Work");
    }
    workIds.add(work.logicalId);
  }
  const taskOrdinals = new Map(tasks.map((task) => [task.logicalId, task.executionOrdinal]));
  for (const task of tasks) {
    if (task.targetScopeRefs.length === 0) throw new Error("Every Task requires a target scope");
    for (const dependency of task.dependencyTaskIds) {
      const ordinal = taskOrdinals.get(dependency);
      if (!ordinal || ordinal >= task.executionOrdinal) {
        throw new Error("Task dependencies must name an earlier Task");
      }
    }
    for (const criterion of task.criteria) {
      if (criterion.sourceGoalFieldIds.length === 0) throw new Error("Criterion Goal trace is empty");
      if (
        criterion.sourceRequiredOutcomeRefs.length !== 1 ||
        criterion.sourceRequiredOutcomeRefs[0] !== requiredOutcomeId
      ) {
        throw new Error("Criterion does not trace the accepted required outcome");
      }
    }
  }
  const coveredFields = new Set(tasks.flatMap((task) =>
    task.criteria.flatMap((criterion) => criterion.sourceGoalFieldIds)));
  if (!coveredFields.has("request") || !coveredFields.has("intended_result")) {
    throw new Error("Planning graph does not cover every required Goal field");
  }
}

function owningWork(drafts: WorkDraft[], taskId: string): WorkDraft {
  const work = drafts.find((candidate) => candidate.tasks.some((task) => task.logicalId === taskId));
  if (!work) throw new Error(`Task has no Work: ${taskId}`);
  return work;
}

function requiredRef(refs: Map<string, ContentRef>, id: string, kind: string): ContentRef {
  const ref = refs.get(id);
  if (!ref) throw new Error(`${kind} dependency is not materialized: ${id}`);
  return ref;
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} is not unique`);
}
