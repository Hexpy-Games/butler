import { createPlannedWorkerToolHandlers } from "../../../tool-support/planned-worker-runtime.ts";

export function createCreatePlannedTaskToolHandler(input: Parameters<typeof createPlannedWorkerToolHandlers>[0]) {
  return createPlannedWorkerToolHandlers(input).create_planned_task;
}
