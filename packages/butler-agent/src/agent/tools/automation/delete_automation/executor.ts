import { createAutomationToolHandlers } from "../shared.ts";

export function createDeleteAutomationToolHandler(input: Parameters<typeof createAutomationToolHandlers>[0]) {
  return createAutomationToolHandlers(input).delete_automation;
}
