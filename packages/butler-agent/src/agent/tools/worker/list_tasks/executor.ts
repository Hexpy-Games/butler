import { createPlannedWorkerToolHandlers } from "../../../tool-support/planned-worker-runtime.ts";

export function createListTasksToolHandler(input: Parameters<typeof createPlannedWorkerToolHandlers>[0]) {
  return createPlannedWorkerToolHandlers(input).list_tasks;
}
