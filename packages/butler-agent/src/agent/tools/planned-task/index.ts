import { createCreatePlannedTaskToolHandler } from "./create_planned_task/executor.ts";
import { createRunPlannedTaskToolHandler } from "./run_planned_task/executor.ts";
import { createReviewPlannedTaskToolHandler } from "./review_planned_task/executor.ts";
import { createRepairPlannedTaskToolHandler } from "./repair_planned_task/executor.ts";
import { createRequestPrincipalDecisionToolHandler } from "./request_principal_decision/executor.ts";
import { createWritePlannedPublicReportToolHandler } from "./write_planned_public_report/executor.ts";
export { dispatchBackgroundTask } from "../../tool-support/planned-worker-runtime.ts";
export type { WorkerModelSelectionRule } from "../../tool-support/planned-worker-runtime.ts";

export function createPlannedTaskToolHandlers(input: Parameters<typeof createCreatePlannedTaskToolHandler>[0]) {
  return {
    "create_planned_task": createCreatePlannedTaskToolHandler(input),
    "run_planned_task": createRunPlannedTaskToolHandler(input),
    "review_planned_task": createReviewPlannedTaskToolHandler(input),
    "repair_planned_task": createRepairPlannedTaskToolHandler(input),
    "request_principal_decision": createRequestPrincipalDecisionToolHandler(input),
    "write_planned_public_report": createWritePlannedPublicReportToolHandler(input),
  };
}
