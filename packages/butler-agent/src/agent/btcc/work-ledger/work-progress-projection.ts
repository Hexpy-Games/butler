import type { ReviewedManagedProgramState } from "./contracts.ts";

export type WorkProgressTaskState =
  | "planned"
  | "active"
  | "reviewing"
  | "completed"
  | "correction_required"
  | "stopped";

export type WorkProgressTask = {
  taskId: string;
  taskTitle: string;
  taskOrder: number;
  taskState: WorkProgressTaskState;
  workId: string;
  workTitle: string;
  workState: "planned" | "active" | "completed" | "cancelled";
};

export function projectWorkProgress(
  program: ReviewedManagedProgramState,
  finalDisposition?: "completed" | "deferred" | "cancelled",
): WorkProgressTask[] {
  const stopped = finalDisposition === "deferred" || finalDisposition === "cancelled";
  const workById = new Map(
    program.works.map(({ work, status }) => [
      work.workLogicalId,
      {
        work,
        state: status === "closed" ? "completed" as const : status,
      },
    ]),
  );
  return program.tasks
    .map(({ task, status }) => {
      const work = workById.get(task.workLogicalId);
      if (!work) throw new Error(`Work progress Task has no Work: ${task.taskLogicalId}`);
      const canonicalTaskState = taskProgressState(status);
      return {
        taskId: task.taskLogicalId,
        taskTitle: task.intendedOutcome,
        taskOrder: task.executionOrdinal,
        taskState: stopped &&
            task.taskLogicalId === program.currentTask.task.taskLogicalId &&
            canonicalTaskState !== "completed"
          ? "stopped"
          : canonicalTaskState,
        workId: work.work.workLogicalId,
        workTitle: work.work.outcome,
        workState: work.state,
      };
    })
    .sort((left, right) => left.taskOrder - right.taskOrder);
}

export function retiredWorkProgress(
  previous: ReviewedManagedProgramState,
  current: ReviewedManagedProgramState,
): WorkProgressTask[] {
  if (previous.programId !== current.programId) return [];
  const currentTaskIds = new Set(
    current.tasks.map(({ task }) => task.taskLogicalId),
  );
  return projectWorkProgress(previous)
    .filter((task) =>
      !currentTaskIds.has(task.taskId) &&
      task.taskState !== "completed" &&
      task.taskState !== "stopped",
    )
    .map((task) => ({
      ...task,
      taskState: "stopped" as const,
      workState: "cancelled" as const,
    }));
}

function taskProgressState(
  status: ReviewedManagedProgramState["tasks"][number]["status"],
): WorkProgressTaskState {
  if (status === "selected") return "active";
  if (status === "result_submitted") return "reviewing";
  if (status === "review_failed") return "correction_required";
  if (status === "accepted") return "completed";
  if (status === "promotion_deferred") return "stopped";
  if (status === "cancelled") return "stopped";
  return "planned";
}
