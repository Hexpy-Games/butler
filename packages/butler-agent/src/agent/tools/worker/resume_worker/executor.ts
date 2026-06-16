import { createPlannedWorkerToolHandlers } from "../../../tool-support/planned-worker-runtime.ts";

export function createResumeWorkerToolHandler(input: Parameters<typeof createPlannedWorkerToolHandlers>[0]) {
  return createPlannedWorkerToolHandlers(input).resume_worker;
}
