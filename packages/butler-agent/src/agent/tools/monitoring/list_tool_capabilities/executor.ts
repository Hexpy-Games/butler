import { createMonitoringToolHandlers } from "../shared.ts";

export function createListToolCapabilitiesToolHandler(input: Parameters<typeof createMonitoringToolHandlers>[0]) {
  return createMonitoringToolHandlers(input).list_tool_capabilities;
}
