import { requireRecord, requireString, requireStringArray } from "../../core/index.ts";
import {
  readArtifactPolicy,
  type DraftArtifactPolicy,
} from "./author-artifact-lifecycle.ts";
import { rejectPlanningProposal } from "./planning-proposal-defect.ts";
import { requireDisplayTitle } from "../../core/display-title.ts";

export type TaskDraft = {
  logicalId: string;
  displayTitle: string;
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
  if (!Array.isArray(value) || value.length === 0) {
    rejectPlanningProposal("works_missing", "Planning requires Works");
  }
  const taskOrdinals = new Map<string, number>();
  const workCompletionOrdinals = new Map<string, number>();
  return value.map((item, workIndex) => {
    const work = requireRecord(item, `works[${workIndex}]`);
    const tasks = work.tasks;
    if (!Array.isArray(tasks) || tasks.length === 0) {
      rejectPlanningProposal("tasks_missing", `works[${workIndex}] requires Tasks`);
    }
    const dependencyWorkIds = requireStringArray(work.dependencyWorkIds, "dependencyWorkIds");
    const workBaseOrdinal = dependencyWorkIds.reduce((maximum, dependencyId) => {
      const ordinal = workCompletionOrdinals.get(dependencyId);
      if (!ordinal) return maximum;
      return Math.max(maximum, ordinal);
    }, 0);
    const draft = {
      logicalId: requireString(work.logicalId, `works[${workIndex}].logicalId`),
      outcome: requireString(work.outcome, `works[${workIndex}].outcome`),
      dependencyWorkIds,
      tasks: tasks.map((task, taskIndex) => {
        const record = requireRecord(task, `works[${workIndex}].tasks[${taskIndex}]`);
        const dependencies = requireStringArray(record.dependencyTaskIds, "dependencyTaskIds");
        const dependencyOrdinal = dependencies.reduce((maximum, dependencyId) => {
          const ordinal = taskOrdinals.get(dependencyId);
          if (!ordinal) return maximum;
          return Math.max(maximum, ordinal);
        }, workBaseOrdinal);
        const taskDraft = readTaskDraft(
          record,
          workIndex,
          taskIndex,
          dependencyOrdinal + 1,
          workspaceScopeRef,
        );
        taskOrdinals.set(taskDraft.logicalId, taskDraft.executionOrdinal);
        return taskDraft;
      }),
    };
    workCompletionOrdinals.set(
      draft.logicalId,
      Math.max(...draft.tasks.map((task) => task.executionOrdinal)),
    );
    return draft;
  });
}

export function validateGraph(
  drafts: WorkDraft[],
  tasks: TaskDraft[],
  requiredOutcomeId: string,
  preservedTaskIds: ReadonlySet<string> = new Set(),
): void {
  assertUnique(drafts.map((work) => work.logicalId), "Work logical id");
  assertUnique(tasks.map((task) => task.logicalId), "Task logical id");
  const workIds = new Set<string>();
  for (const work of drafts) {
    if (work.dependencyWorkIds.some((id) => !workIds.has(id))) {
      rejectPlanningProposal(
        "work_dependency_order",
        "Work dependencies must name an earlier Work",
      );
    }
    workIds.add(work.logicalId);
  }
  const taskOrdinals = new Map(tasks.map((task) => [task.logicalId, task.executionOrdinal]));
  for (const task of tasks) {
    validateTask(task, taskOrdinals, requiredOutcomeId, preservedTaskIds.has(task.logicalId));
  }
  validateArtifactDependencyContinuity(tasks);
  const coveredFields = new Set(tasks.flatMap((task) =>
    task.criteria.flatMap((criterion) => criterion.sourceGoalFieldIds)));
  if (!coveredFields.has("request") || !coveredFields.has("intended_result")) {
    rejectPlanningProposal(
      "goal_coverage_incomplete",
      "Planning graph does not cover every required Goal field",
    );
  }
}

function validateArtifactDependencyContinuity(tasks: TaskDraft[]): void {
  const tasksById = new Map(tasks.map((task) => [task.logicalId, task]));
  for (const successor of tasks) {
    for (const dependencyId of successor.dependencyTaskIds) {
      const predecessor = tasksById.get(dependencyId);
      if (predecessor?.artifactPolicy?.kind !== "workspace_artifact") continue;
      const successorPolicy = successor.artifactPolicy;
      if (
        successorPolicy?.kind !== "workspace_artifact" &&
        successorPolicy?.kind !== "repository_promotion"
      ) {
        rejectPlanningProposal(
          "artifact_dependency_not_materialized",
          "A Task that depends on workspace bytes must continue on an artifact target",
        );
      }
      const predecessorScope = predecessor.artifactPolicy.workspaceScopeRef;
      const successorScope = successorPolicy.kind === "workspace_artifact"
        ? successorPolicy.workspaceScopeRef
        : successorPolicy.targetScopeRef;
      if (successorScope !== predecessorScope) {
        rejectPlanningProposal(
          "artifact_dependency_target_mismatch",
          "Dependent artifact Tasks must share the exact artifact workspace root",
        );
      }
    }
  }
}

export function owningWork(drafts: WorkDraft[], taskId: string): WorkDraft {
  const work = drafts.find((candidate) => candidate.tasks.some((task) => task.logicalId === taskId));
  if (!work) rejectPlanningProposal("task_without_work", `Task has no Work: ${taskId}`);
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
  if (!Array.isArray(criteria) || criteria.length === 0) {
    rejectPlanningProposal("criteria_missing", `${label} requires criteria`);
  }
  const artifactPolicy = readArtifactPolicy(task.artifactPolicy, label, workspaceScopeRef);
  const effectClass = requireString(task.effectClass, `${label}.effectClass`);
  if (effectClass !== "none" && effectClass !== "external_effect") {
    rejectPlanningProposal("effect_class_invalid", `${label}.effectClass is invalid`);
  }
  if (artifactPolicy?.kind === "workspace_artifact" && effectClass === "external_effect" &&
    artifactPolicy.mutationScope.kind !== "read_only") {
    rejectPlanningProposal(
      "workspace_artifact_effect_conflict",
      "External-effect Task may observe workspace bytes only through a read-only artifact policy",
    );
  }
  if (artifactPolicy?.kind === "repository_promotion" && effectClass !== "external_effect") {
    rejectPlanningProposal(
      "promotion_effect_missing",
      "Repository promotion Task requires an external effect",
    );
  }
  const declaredTargetScopes = requireStringArray(task.targetScopeRefs, "targetScopeRefs");
  const targetScopeRefs = artifactPolicy?.kind === "workspace_artifact"
    ? [...new Set([artifactPolicy.workspaceScopeRef, ...declaredTargetScopes])]
    : artifactPolicy?.kind === "repository_promotion"
      ? [artifactPolicy.targetScopeRef]
      : declaredTargetScopes;
  return {
    logicalId: requireString(task.logicalId, `${label}.logicalId`),
    displayTitle: requireDisplayTitle(task.displayTitle, `${label}.displayTitle`),
    intendedOutcome: requireString(task.intendedOutcome, `${label}.intendedOutcome`),
    executionOrdinal,
    dependencyTaskIds: requireStringArray(task.dependencyTaskIds, "dependencyTaskIds"),
    effectClass,
    targetScopeRefs,
    ...(artifactPolicy ? { artifactPolicy } : {}),
    criteria: criteria.map((item, criterionIndex) => {
      const criterion = requireRecord(item, `${label}.criteria[${criterionIndex}]`);
      const fields = requireStringArray(criterion.sourceGoalFieldIds, "sourceGoalFieldIds");
      if (fields.some((field) => field !== "request" && field !== "intended_result")) {
        rejectPlanningProposal(
          "criterion_goal_field_invalid",
          "Planning criterion references an unknown Goal field",
        );
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
  preservesAcceptedOutcome: boolean,
): void {
  if (task.artifactPolicy?.kind !== "repository_promotion" && task.targetScopeRefs.length === 0) {
    rejectPlanningProposal(
      "task_target_scope_missing",
      "Every executable Task requires a target scope",
    );
  }
  for (const dependency of task.dependencyTaskIds) {
    const ordinal = ordinals.get(dependency);
    if (!ordinal || ordinal >= task.executionOrdinal) {
      rejectPlanningProposal(
        "task_dependency_order",
        "Task dependencies must name an earlier Task",
      );
    }
  }
  for (const criterion of task.criteria) {
    if (criterion.sourceGoalFieldIds.length === 0) {
      rejectPlanningProposal("criterion_goal_trace_empty", "Criterion Goal trace is empty");
    }
    if (!preservesAcceptedOutcome && (
      criterion.sourceRequiredOutcomeRefs.length !== 1 ||
      criterion.sourceRequiredOutcomeRefs[0] !== requiredOutcomeId
    )) {
      rejectPlanningProposal(
        "criterion_required_outcome_mismatch",
        "Criterion does not trace the accepted required outcome",
      );
    }
  }
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    rejectPlanningProposal("logical_id_duplicate", `${label} is not unique`);
  }
}
