import { createProjectLedgerToolHandlers } from "../shared.ts";

export function createCompleteProjectWorkToolHandler(input: Parameters<typeof createProjectLedgerToolHandlers>[0]) {
  return createProjectLedgerToolHandlers(input).complete_project_work;
}
