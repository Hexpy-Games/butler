import { getWorkTasks, type CanonStatus, type EpicCard, type EpicInput } from "@/app/canonApi.ts";

/** Temporary wm-Task adapter. Canon remains separate from BTCC. */
export const readCanonProgress = getWorkTasks;
export const canonTaskCounts = (epic: EpicCard) => epic.task_counts;

export function canFinishCanonEpic(epic: EpicCard): boolean {
  return !["running", "in_review"].includes(epic.run_state);
}

export function canonStatusInput(epic: EpicCard, status: CanonStatus): EpicInput {
  return { status, ...(["done", "cancelled"].includes(status)
    ? { expected_task_graph_revision: epic.task_graph_revision } : {}) };
}
