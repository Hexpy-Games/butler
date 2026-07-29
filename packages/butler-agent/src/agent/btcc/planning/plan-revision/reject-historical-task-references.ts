import { requireRecord, requireString } from "../../core/index.ts";
import type { PlanningCandidate } from "../contracts.ts";

export function rejectHistoricalTaskReferences(input: {
  revisedPlan: Record<string, unknown>;
  acceptedPlan: PlanningCandidate;
  taskImpactIndex: unknown[];
}): void {
  const current = new Set(input.acceptedPlan.tasks.map((task) => task.taskLogicalId));
  const historical = new Set(input.taskImpactIndex.flatMap((value, index) => {
    const state = requireRecord(value, `taskImpactIndex[${index}]`);
    const task = requireRecord(state.task, `taskImpactIndex[${index}].task`);
    const id = requireString(task.taskLogicalId, "taskImpactIndex.task.taskLogicalId");
    return current.has(id) ? [] : [id];
  }));
  if (historical.size === 0) return;

  const referenced = revisedPlanTaskDefinitions(input.revisedPlan)
    .find((taskId) => historical.has(taskId));
  if (!referenced) return;
  throw new Error(
    `Historical accepted Task ${referenced} is not current Plan authority; ` +
    "keep it unaffected and omit it from revised Plan Task definitions. " +
    "An admitted carried artifact may still be named by lifecycle selectors.",
  );
}

function revisedPlanTaskDefinitions(plan: Record<string, unknown>): string[] {
  const refs: string[] = [];
  for (const value of array(plan.works)) {
    const work = requireRecord(value, "revisedPlan.work");
    for (const taskValue of array(work.tasks)) {
      const task = requireRecord(taskValue, "revisedPlan.task");
      refs.push(requireString(task.logicalId, "revisedPlan.task.logicalId"));
    }
  }
  return refs;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
