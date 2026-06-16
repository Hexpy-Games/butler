import { createProjectLedgerToolHandlers } from "../shared.ts";

export function createGetWorkDashboardToolHandler(input: Parameters<typeof createProjectLedgerToolHandlers>[0]) {
  return createProjectLedgerToolHandlers(input).get_work_dashboard;
}
