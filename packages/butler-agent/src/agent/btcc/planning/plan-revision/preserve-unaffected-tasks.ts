import { requireRecord, requireString, type ContentRef } from "../../core/index.ts";
import { legacyDisplayTitle } from "../../core/display-title.ts";
import type {
  ManagedTask,
  ManagedWork,
  PlanningCandidate,
  TaskArtifactPolicy,
} from "../contracts.ts";

export function preserveUnaffectedTaskDrafts(input: {
  revisedPlan: Record<string, unknown>;
  impactMap: unknown;
  acceptedPlan: PlanningCandidate;
}): Record<string, unknown> {
  return preserveAcceptedTaskDrafts({
    revisedPlan: input.revisedPlan,
    taskLogicalIds: [...unaffectedTaskIds(input.impactMap)],
    acceptedPlan: input.acceptedPlan,
  });
}

export function preserveAcceptedTaskDrafts(input: {
  revisedPlan: Record<string, unknown>;
  taskLogicalIds: string[];
  acceptedPlan: PlanningCandidate;
}): Record<string, unknown> {
  const preserved = new Set(input.taskLogicalIds);
  if (preserved.size === 0) return input.revisedPlan;

  const priorTasks = new Map(
    input.acceptedPlan.tasks.map((task) => [task.taskLogicalId, task]),
  );
  const nextWorks = requiredArray(input.revisedPlan.works, "revisedPlan.works")
    .map((value, index) => decodeWorkDraft(value, index));

  for (const taskId of preserved) {
    const priorTask = priorTasks.get(taskId);
    if (!priorTask) continue;
    removeTaskDraft(nextWorks, priorTask.taskLogicalId);
    const work = findOrRestoreWork(nextWorks, priorTask, input.acceptedPlan);
    restoreTaskAtAcceptedPosition(work, priorTask, input.acceptedPlan);
  }
  return { ...input.revisedPlan, works: nextWorks };
}

export function acceptedUnaffectedTaskIds(
  impactMap: unknown,
  acceptedPlan: PlanningCandidate,
): string[] {
  const accepted = new Set(acceptedPlan.tasks.map((task) => task.taskLogicalId));
  return [...unaffectedTaskIds(impactMap)].filter((taskId) => accepted.has(taskId));
}

type WorkDraft = Record<string, unknown> & {
  logicalId: string;
  tasks: Record<string, unknown>[];
};

function decodeWorkDraft(value: unknown, workIndex: number): WorkDraft {
  const work = requireRecord(value, `revisedPlan.works[${workIndex}]`);
  const logicalId = requireString(
    work.logicalId,
    `revisedPlan.works[${workIndex}].logicalId`,
  );
  const tasks = requiredArray(work.tasks, `revisedPlan.works[${workIndex}].tasks`)
    .map((task, taskIndex) =>
      requireRecord(task, `revisedPlan.works[${workIndex}].tasks[${taskIndex}]`));
  return { ...work, logicalId, tasks };
}

function removeTaskDraft(works: WorkDraft[], taskLogicalId: string): void {
  for (const work of works) {
    work.tasks = work.tasks.filter((task) => task.logicalId !== taskLogicalId);
  }
}

function findOrRestoreWork(
  works: WorkDraft[],
  priorTask: ManagedTask,
  plan: PlanningCandidate,
): WorkDraft {
  const existing = works.find((work) => work.logicalId === priorTask.workLogicalId);
  if (existing) return existing;
  const priorWork = plan.works.find(
    (work) => work.workLogicalId === priorTask.workLogicalId,
  );
  if (!priorWork) throw new Error(`Accepted Plan is missing Work ${priorTask.workLogicalId}`);
  const restored = reconstructWorkDraft(priorWork, plan);
  works.splice(Math.min(plan.works.indexOf(priorWork), works.length), 0, restored);
  return restored;
}

function restoreTaskAtAcceptedPosition(
  work: WorkDraft,
  priorTask: ManagedTask,
  plan: PlanningCandidate,
): void {
  const existingIndexes = work.tasks.flatMap((task, index) =>
    task.logicalId === priorTask.taskLogicalId ? [index] : []);
  if (existingIndexes.length > 1) {
    throw new Error(`Revised Plan duplicates Task ${priorTask.taskLogicalId}`);
  }
  const restored = reconstructTaskDraft(priorTask, plan);
  if (existingIndexes.length === 1) {
    work.tasks[existingIndexes[0]!] = restored;
    return;
  }
  const priorWork = plan.works.find((candidate) =>
    candidate.workLogicalId === priorTask.workLogicalId);
  if (!priorWork) throw new Error(`Accepted Plan is missing Work ${priorTask.workLogicalId}`);
  const acceptedIndex = priorWork.taskRefs.findIndex((ref) => refKey(ref) === refKey(priorTask.ref));
  if (acceptedIndex < 0) throw new Error(`Accepted Work is missing Task ${priorTask.taskLogicalId}`);
  work.tasks.splice(Math.min(acceptedIndex, work.tasks.length), 0, restored);
}

function reconstructWorkDraft(work: ManagedWork, plan: PlanningCandidate): WorkDraft {
  const workIdsByRef = new Map(
    plan.works.map((candidate) => [refKey(candidate.ref), candidate.workLogicalId]),
  );
  return {
    logicalId: work.workLogicalId,
    outcome: work.outcome,
    dependencyWorkIds: work.dependencyWorkRefs.map((ref) =>
      requiredLookup(workIdsByRef, ref, "dependency Work")),
    tasks: [],
  };
}

function unaffectedTaskIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  for (const [index, item] of requiredArray(value, "impactMap").entries()) {
    const impact = requireRecord(item, `impactMap[${index}]`);
    if (impact.disposition !== "unaffected") continue;
    ids.add(requireString(impact.priorTaskLogicalId, "priorTaskLogicalId"));
  }
  return ids;
}

function reconstructTaskDraft(
  task: ManagedTask,
  plan: PlanningCandidate,
): Record<string, unknown> {
  const taskIdsByRef = new Map(
    plan.tasks.map((candidate) => [refKey(candidate.ref), candidate.taskLogicalId]),
  );
  const criteriaByRef = new Map(plan.criteria.map((item) => [refKey(item.ref), item]));
  const questionsByRef = new Map(
    plan.verificationQuestions.map((item) => [refKey(item.ref), item]),
  );
  return {
    logicalId: task.taskLogicalId,
    displayTitle: task.displayTitle ?? legacyDisplayTitle(task.intendedOutcome),
    intendedOutcome: task.intendedOutcome,
    dependencyTaskIds: task.dependencyTaskRefs.map((ref) =>
      requiredLookup(taskIdsByRef, ref, "dependency Task")),
    effectClass: task.effectClass,
    targetScopeRefs: task.targetScopeRefs,
    ...draftArtifactPolicy(task.artifactPolicy),
    criteria: task.criterionRefs.map((criterionRef, index) => {
      const criterion = requiredLookup(criteriaByRef, criterionRef, "criterion");
      const questionRef = task.verificationQuestionRefs[index];
      if (!questionRef) throw new Error(`Task ${task.taskLogicalId} is missing a question`);
      const question = requiredLookup(questionsByRef, questionRef, "verification question");
      if (refKey(question.criterionRef) !== refKey(criterion.ref)) {
        throw new Error(`Task ${task.taskLogicalId} question does not match its criterion`);
      }
      return {
        statement: criterion.statement,
        question: question.question,
        sourceGoalFieldIds: criterion.sourceGoalFieldIds,
        sourceRequiredOutcomeRefs: criterion.sourceRequiredOutcomeRefs,
      };
    }),
  };
}

function draftArtifactPolicy(policy: TaskArtifactPolicy): Record<string, unknown> {
  if (policy.kind === "non_artifact") return {};
  if (policy.kind === "repository_promotion") {
    return { artifactPolicy: { kind: policy.kind, targetPath: policy.targetPath } };
  }
  return {
    artifactPolicy: {
      kind: policy.kind,
      workspacePath: policy.workspacePath,
      mutationScope: policy.mutationScope,
    },
  };
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requiredLookup<T>(
  values: Map<string, T>,
  ref: ContentRef,
  label: string,
): T {
  const value = values.get(refKey(ref));
  if (!value) throw new Error(`Accepted Plan is missing ${label} ${ref.id}`);
  return value;
}

function refKey(ref: ContentRef): string {
  return `${ref.id}\0${ref.sha256}`;
}
