import { getEpicProgress, type CanonStatus, type EpicCard, type EpicInput } from "@/app/canonApi.ts";

/** Empty link progress; branch 4 supplies the derived BTCC view. */
export const readCanonProgress = getEpicProgress;
export const canonTaskCounts = (epic: EpicCard) => epic.task_counts;

export function canFinishCanonEpic(_epic: EpicCard): boolean {
  return true;
}

export function canonStatusInput(_epic: EpicCard, status: CanonStatus): EpicInput {
  return { status };
}
