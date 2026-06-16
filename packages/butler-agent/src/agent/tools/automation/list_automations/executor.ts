import { createAutomationToolHandlers } from "../shared.ts";

export function createListAutomationsToolHandler(input: Parameters<typeof createAutomationToolHandlers>[0]) {
  return createAutomationToolHandlers(input).list_automations;
}
