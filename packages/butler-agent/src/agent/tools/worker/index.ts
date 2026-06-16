import { createDispatchWorkerToolHandler } from "./dispatch_worker/executor.ts";
import { createResumeWorkerToolHandler } from "./resume_worker/executor.ts";
import { createListTasksToolHandler } from "./list_tasks/executor.ts";
import { createGetTaskResultToolHandler } from "./get_task_result/executor.ts";

export function createWorkerToolHandlers(input: Parameters<typeof createDispatchWorkerToolHandler>[0]) {
  return {
    "dispatch_worker": createDispatchWorkerToolHandler(input),
    "resume_worker": createResumeWorkerToolHandler(input),
    "list_tasks": createListTasksToolHandler(input),
    "get_task_result": createGetTaskResultToolHandler(input),
  };
}
