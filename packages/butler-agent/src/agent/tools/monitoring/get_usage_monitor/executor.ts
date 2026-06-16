import { createMonitoringToolHandlers } from "../shared.ts";

export function createGetUsageMonitorToolHandler(input: Parameters<typeof createMonitoringToolHandlers>[0]) {
  return createMonitoringToolHandlers(input).get_usage_monitor;
}
