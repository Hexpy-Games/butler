import { requireStringArray, type ContentRef } from "../../core/index.ts";
import type { ManagedTask } from "../contracts.ts";
import { rejectPlanningProposal } from "./planning-proposal-defect.ts";

export function taskMap(tasks: ManagedTask[]): Map<string, ManagedTask> {
  return new Map(tasks.map((task) => [task.taskLogicalId, task]));
}

export function requiredTaskRecord(
  tasks: Map<string, ManagedTask>,
  logicalId: string,
): ManagedTask {
  const task = tasks.get(logicalId);
  if (!task) {
    rejectPlanningProposal("task_reference_unknown",
      `Planning reference has no Task: ${logicalId}`);
  }
  return task;
}

export function taskByRef(tasks: ManagedTask[], ref: ContentRef): ManagedTask {
  const task = tasks.find((candidate) => candidate.ref.id === ref.id);
  if (!task) {
    rejectPlanningProposal("task_reference_unknown",
      `Planning reference has no Task: ${ref.id}`);
  }
  return task;
}

export function readGoalFields(value: unknown): Array<"request" | "intended_result"> {
  const fields = uniqueStrings(requireStringArray(value, "sourceGoalFieldIds"), "Goal field");
  if (fields.length === 0 || fields.some((field) =>
    field !== "request" && field !== "intended_result")) {
    rejectPlanningProposal("planning_goal_trace_invalid",
      "Planning record references an unknown or empty Goal field set");
  }
  return fields as Array<"request" | "intended_result">;
}

export function readRequiredOutcomeRefs(value: unknown, requiredOutcomeId: string): string[] {
  const refs = uniqueStrings(requireStringArray(value, "sourceRequiredOutcomeRefs"), "Outcome ref");
  if (refs.length !== 1 || refs[0] !== requiredOutcomeId) {
    rejectPlanningProposal("planning_required_outcome_mismatch",
      "Planning record does not bind the accepted required outcome");
  }
  return refs;
}

export function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    rejectPlanningProposal("planning_array_invalid", `${label} must be an array`);
  }
  return value;
}

export function uniqueStrings(values: string[], label: string): string[] {
  if (new Set(values).size !== values.length) {
    rejectPlanningProposal("planning_reference_duplicate", `${label} is not unique`);
  }
  return values;
}

export function uniqueRefs(refs: ContentRef[]): ContentRef[] {
  return [...new Map(refs.map((ref) => [ref.id, ref])).values()];
}

export function assertExactStrings(actual: string[], expected: string[], label: string): void {
  if (actual.length !== expected.length || actual.some((id) => !expected.includes(id))) {
    rejectPlanningProposal("planned_graph_mismatch",
      `${label} does not match the planned graph`);
  }
}
