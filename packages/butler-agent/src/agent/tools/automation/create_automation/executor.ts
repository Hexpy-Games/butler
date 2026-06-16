import { createAutomationToolHandlers } from "../shared.ts";

export function createCreateAutomationToolHandler(input: Parameters<typeof createAutomationToolHandlers>[0]) {
  return createAutomationToolHandlers(input).create_automation;
}
