import { createProjectLedgerNativeToolHandler } from "../native.ts";

export function createProjectLedgerAttemptSucceedToolHandler(input: Parameters<typeof createProjectLedgerNativeToolHandler>[0]) {
  return createProjectLedgerNativeToolHandler(input, "project_ledger_attempt_succeed");
}
