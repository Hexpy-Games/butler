import { createGetWorkDashboardToolHandler } from "./get_work_dashboard/executor.ts";
import { createInspectProjectStatusToolHandler } from "./inspect_project_status/executor.ts";
import { createQueryProjectWorkToolHandler } from "./query_project_work/executor.ts";
import { createRenderProjectDashboardToolHandler } from "./render_project_dashboard/executor.ts";
import { createCompleteProjectWorkToolHandler } from "./complete_project_work/executor.ts";

export function createProjectLedgerToolHandlers(input: Parameters<typeof createGetWorkDashboardToolHandler>[0]) {
  return {
    "get_work_dashboard": createGetWorkDashboardToolHandler(input),
    "inspect_project_status": createInspectProjectStatusToolHandler(input),
    "query_project_work": createQueryProjectWorkToolHandler(input),
    "render_project_dashboard": createRenderProjectDashboardToolHandler(input),
    "complete_project_work": createCompleteProjectWorkToolHandler(input),
  };
}
