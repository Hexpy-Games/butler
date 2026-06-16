import { createPlannedWorkerToolHandlers } from "../../../tool-support/planned-worker-runtime.ts";

export function createDispatchWorkerToolHandler(input: Parameters<typeof createPlannedWorkerToolHandlers>[0]) {
  return createPlannedWorkerToolHandlers(input).dispatch_worker;
}
