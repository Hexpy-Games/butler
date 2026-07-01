import { createProjectLedgerNativeToolHandler } from "../native.ts";

export function createProjectLedgerIndexToolHandler(input: Parameters<typeof createProjectLedgerNativeToolHandler>[0]) {
  return createProjectLedgerNativeToolHandler(input, "project_ledger_index");
}
