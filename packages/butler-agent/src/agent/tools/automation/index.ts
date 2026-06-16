import { createCreateAutomationToolHandler } from "./create_automation/executor.ts";
import { createListAutomationsToolHandler } from "./list_automations/executor.ts";
import { createDeleteAutomationToolHandler } from "./delete_automation/executor.ts";
import { createRunDueAutomationsToolHandler } from "./run_due_automations/executor.ts";

export function createAutomationToolHandlers(input: Parameters<typeof createCreateAutomationToolHandler>[0]) {
  return {
    "create_automation": createCreateAutomationToolHandler(input),
    "list_automations": createListAutomationsToolHandler(input),
    "delete_automation": createDeleteAutomationToolHandler(input),
    "run_due_automations": createRunDueAutomationsToolHandler(input),
  };
}
