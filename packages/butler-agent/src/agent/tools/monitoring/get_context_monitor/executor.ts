import { createMonitoringToolHandlers } from "../shared.ts";

export function createGetContextMonitorToolHandler(input: Parameters<typeof createMonitoringToolHandlers>[0]) {
  return createMonitoringToolHandlers(input).get_context_monitor;
}
