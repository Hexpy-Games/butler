import { createProjectLedgerNativeToolHandler } from "../native.ts";

export function createProjectLedgerRenderToolHandler(input: Parameters<typeof createProjectLedgerNativeToolHandler>[0]) {
  return createProjectLedgerNativeToolHandler(input, "project_ledger_render");
}
