import { createAutomationToolHandlers } from "../shared.ts";

export function createRunDueAutomationsToolHandler(input: Parameters<typeof createAutomationToolHandlers>[0]) {
  return createAutomationToolHandlers(input).run_due_automations;
}
