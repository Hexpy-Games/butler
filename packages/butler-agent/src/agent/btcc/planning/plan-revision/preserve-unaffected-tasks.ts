import { requireRecord, requireString, type ContentRef } from "../../core/index.ts";
import type {
  ManagedTask,
  PlanningCandidate,
  TaskArtifactPolicy,
} from "../contracts.ts";

export function preserveUnaffectedTaskDrafts(input: {
  revisedPlan: Record<string, unknown>;
  impactMap: unknown;
  acceptedPlan: PlanningCandidate;
}): Record<string, unknown> {
  const unaffected = unaffectedTaskIds(input.impactMap);
  if (unaffected.size === 0) return input.revisedPlan;

  const priorTasks = new Map(
    input.acceptedPlan.tasks.map((task) => [task.taskLogicalId, task]),
  );
  const reconstructed = new Set<string>();
  const works = requiredArray(input.revisedPlan.works, "revisedPlan.works");
  const nextWorks = works.map((value, workIndex) => {
    const work = requireRecord(value, `revisedPlan.works[${workIndex}]`);
    const workId = requireString(work.logicalId, `revisedPlan.works[${workIndex}].logicalId`);
    const tasks = requiredArray(work.tasks, `revisedPlan.works[${workIndex}].tasks`);
    return {
      ...work,
      tasks: tasks.map((taskValue, taskIndex) => {
        const task = requireRecord(
          taskValue,
          `revisedPlan.works[${workIndex}].tasks[${taskIndex}]`,
        );
        const taskId = requireString(task.logicalId, "revised Task logicalId");
        if (!unaffected.has(taskId)) return task;
        const prior = priorTasks.get(taskId);
        if (!prior) throw new Error(`Unaffected Task is absent from accepted Plan: ${taskId}`);
        if (prior.workLogicalId !== workId) {
          throw new Error(
            `Unaffected Task ${taskId} must remain in Work ${prior.workLogicalId}`,
          );
        }
        reconstructed.add(taskId);
        return reconstructTaskDraft(prior, input.acceptedPlan);
      }),
    };
  });

  for (const taskId of unaffected) {
    if (!reconstructed.has(taskId)) {
      throw new Error(`Unaffected Task is missing from revised Plan: ${taskId}`);
    }
  }
  return { ...input.revisedPlan, works: nextWorks };
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
