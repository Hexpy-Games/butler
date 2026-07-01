import { createProjectLedgerNativeToolHandler } from "../native.ts";

export function createProjectLedgerUpdateToolHandler(input: Parameters<typeof createProjectLedgerNativeToolHandler>[0]) {
  return createProjectLedgerNativeToolHandler(input, "project_ledger_update");
}
