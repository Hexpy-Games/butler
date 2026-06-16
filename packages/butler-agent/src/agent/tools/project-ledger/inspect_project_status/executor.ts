import { createProjectLedgerToolHandlers } from "../shared.ts";

export function createInspectProjectStatusToolHandler(input: Parameters<typeof createProjectLedgerToolHandlers>[0]) {
  return createProjectLedgerToolHandlers(input).inspect_project_status;
}
