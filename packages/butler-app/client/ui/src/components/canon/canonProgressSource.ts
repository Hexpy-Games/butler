import { getEpicProgress, type CanonStatus, type EpicCard, type EpicInput } from "@/app/canonApi.ts";

/** Derived Work progress stays read only in canon. */
export const readCanonProgress = getEpicProgress;
export const canonTaskCounts = (epic: EpicCard) => epic.task_counts;

export function canFinishCanonEpic(epic: EpicCard): boolean {
  return epic.running !== true;
}

export function canonStatusInput(_epic: EpicCard, status: CanonStatus): EpicInput {
  return { status };
}
