import { createPlannedWorkerToolHandlers } from "../../../tool-support/planned-worker-runtime.ts";

export function createRepairPlannedTaskToolHandler(input: Parameters<typeof createPlannedWorkerToolHandlers>[0]) {
  return createPlannedWorkerToolHandlers(input).repair_planned_task;
}
