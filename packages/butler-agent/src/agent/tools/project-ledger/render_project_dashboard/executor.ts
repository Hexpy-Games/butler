import { createProjectLedgerToolHandlers } from "../shared.ts";

export function createRenderProjectDashboardToolHandler(input: Parameters<typeof createProjectLedgerToolHandlers>[0]) {
  return createProjectLedgerToolHandlers(input).render_project_dashboard;
}
