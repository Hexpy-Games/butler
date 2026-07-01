import { createProjectLedgerNativeToolHandler } from "../native.ts";

export function createProjectLedgerShowToolHandler(input: Parameters<typeof createProjectLedgerNativeToolHandler>[0]) {
  return createProjectLedgerNativeToolHandler(input, "project_ledger_show");
}
