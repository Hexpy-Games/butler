import { createProjectLedgerToolHandlers } from "../shared.ts";

export function createQueryProjectWorkToolHandler(input: Parameters<typeof createProjectLedgerToolHandlers>[0]) {
  return createProjectLedgerToolHandlers(input).query_project_work;
}
