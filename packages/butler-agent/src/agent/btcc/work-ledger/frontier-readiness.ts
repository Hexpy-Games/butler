import type { ReviewedManagedProgramState } from "./contracts.ts";

type ManagedTaskState = ReviewedManagedProgramState["tasks"][number];

export function nextDependencyReadyTask(
  tasks: ManagedTaskState[],
  accepts: (task: ManagedTaskState) => boolean = () => true,
): ManagedTaskState | undefined {
  const accepted = new Set(
    tasks.filter((task) => task.status === "accepted").map((task) => task.task.ref.id),
  );
  return tasks
    .filter(accepts)
    .filter((task) => task.status === "planned" || task.status === "result_submitted")
    .filter((task) => task.task.dependencyTaskRefs.every((ref) => accepted.has(ref.id)))
    .sort((left, right) => left.task.executionOrdinal - right.task.executionOrdinal)[0];
}

export function canOpenPromotionFrontier(
  program: ReviewedManagedProgramState,
): boolean {
  if (program.frontier !== "implementation_open") return false;
  const isPromotion = (task: ManagedTaskState) =>
    task.task.artifactPolicy.kind === "repository_promotion";
  return !nextDependencyReadyTask(program.tasks, (task) => !isPromotion(task)) &&
    Boolean(nextDependencyReadyTask(program.tasks, isPromotion));
}
