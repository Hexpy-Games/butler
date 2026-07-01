import { createProjectLedgerNativeToolHandler } from "../native.ts";

export function createProjectLedgerWorkUpdateToolHandler(input: Parameters<typeof createProjectLedgerNativeToolHandler>[0]) {
  return createProjectLedgerNativeToolHandler(input, "project_ledger_work_update");
}
