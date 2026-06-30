import { createProjectLedgerNativeToolHandler } from "../native.ts";

export function createProjectLedgerTaskCompleteToolHandler(input: Parameters<typeof createProjectLedgerNativeToolHandler>[0]) {
  return createProjectLedgerNativeToolHandler(input, "project_ledger_task_complete");
}
