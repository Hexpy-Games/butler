import { requireRecord, requireString, requireStringArray } from "../../core/index.ts";
import {
  readArtifactPolicy,
  type DraftArtifactPolicy,
} from "./author-artifact-lifecycle.ts";

export type TaskDraft = {
  logicalId: string;
  intendedOutcome: string;
  executionOrdinal: number;
  dependencyTaskIds: string[];
  effectClass: "none" | "external_effect";
  targetScopeRefs: string[];
  artifactPolicy?: DraftArtifactPolicy;
  criteria: CriterionDraft[];
};

type CriterionDraft = {
  statement: string;
  question: string;
  sourceGoalFieldIds: Array<"request" | "intended_result">;
  sourceRequiredOutcomeRefs: string[];
};

export type WorkDraft = {
  logicalId: string;
  outcome: string;
  dependencyWorkIds: string[];
  tasks: TaskDraft[];
};

export function readWorkDrafts(
  value: unknown,
  workspaceScopeRef: string,
): WorkDraft[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Planning requires Works");
  let executionOrdinal = 0;
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
      tasks: tasks.map((task, taskIndex) => readTaskDraft(
        task, workIndex, taskIndex, ++executionOrdinal, workspaceScopeRef,
      )),
    };
  });
}

export function validateGraph(
  drafts: WorkDraft[],
  tasks: TaskDraft[],
  requiredOutcomeId: string,
): void {
  assertUnique(drafts.map((work) => work.logicalId), "Work logical id");
  assertUnique(tasks.map((task) => task.logicalId), "Task logical id");
  const workIds = new Set<string>();
  for (const work of drafts) {
    if (work.dependencyWorkIds.some((id) => !workIds.has(id))) {
      throw new Error("Work dependencies must name an earlier Work");
    }
    workIds.add(work.logicalId);
  }
  const taskOrdinals = new Map(tasks.map((task) => [task.logicalId, task.executionOrdinal]));
  for (const task of tasks) validateTask(task, taskOrdinals, requiredOutcomeId);
  const coveredFields = new Set(tasks.flatMap((task) =>
    task.criteria.flatMap((criterion) => criterion.sourceGoalFieldIds)));
  if (!coveredFields.has("request") || !coveredFields.has("intended_result")) {
    throw new Error("Planning graph does not cover every required Goal field");
  }
}

export function owningWork(drafts: WorkDraft[], taskId: string): WorkDraft {
  const work = drafts.find((candidate) => candidate.tasks.some((task) => task.logicalId === taskId));
  if (!work) throw new Error(`Task has no Work: ${taskId}`);
  return work;
}

function readTaskDraft(
  value: unknown,
  workIndex: number,
  taskIndex: number,
  executionOrdinal: number,
  workspaceScopeRef: string,
): TaskDraft {
  const label = `works[${workIndex}].tasks[${taskIndex}]`;
  const task = requireRecord(value, label);
  const criteria = task.criteria;
  if (!Array.isArray(criteria) || criteria.length === 0) throw new Error(`${label} requires criteria`);
  const artifactPolicy = readArtifactPolicy(task.artifactPolicy, label, workspaceScopeRef);
  const effectClass = requireString(task.effectClass, `${label}.effectClass`);
  if (effectClass !== "none" && effectClass !== "external_effect") {
    throw new Error(`${label}.effectClass is invalid`);
  }
  if (artifactPolicy?.kind === "workspace_artifact" && effectClass !== "none") {
    throw new Error("Workspace artifact Task cannot declare an external effect");
  }
  if (artifactPolicy?.kind === "repository_promotion" && effectClass !== "external_effect") {
    throw new Error("Repository promotion Task requires an external effect");
  }
  return {
    logicalId: requireString(task.logicalId, `${label}.logicalId`),
    intendedOutcome: requireString(task.intendedOutcome, `${label}.intendedOutcome`),
    executionOrdinal,
    dependencyTaskIds: requireStringArray(task.dependencyTaskIds, "dependencyTaskIds"),
    effectClass,
    targetScopeRefs: artifactPolicy
      ? artifactPolicy.kind === "workspace_artifact" ? [artifactPolicy.targetScopeRef] : []
      : requireStringArray(task.targetScopeRefs, "targetScopeRefs"),
    ...(artifactPolicy ? { artifactPolicy } : {}),
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
          "criterion.sourceRequiredOutcomeRefs",
        ),
      };
    }),
  };
}

function validateTask(
  task: TaskDraft,
  ordinals: Map<string, number>,
  requiredOutcomeId: string,
): void {
  if (task.artifactPolicy?.kind !== "repository_promotion" && task.targetScopeRefs.length === 0) {
    throw new Error("Every executable Task requires a target scope");
  }
  for (const dependency of task.dependencyTaskIds) {
    const ordinal = ordinals.get(dependency);
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

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} is not unique`);
}
