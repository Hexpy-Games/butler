import { createMonitoringToolHandlers } from "../shared.ts";

export function createGetMemoryHealthToolHandler(input: Parameters<typeof createMonitoringToolHandlers>[0]) {
  return createMonitoringToolHandlers(input).get_memory_health;
}
