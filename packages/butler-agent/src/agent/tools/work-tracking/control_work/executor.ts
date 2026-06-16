import { createWorkTrackingToolHandlers } from "../shared.ts";

export function createControlWorkToolHandler(input: Parameters<typeof createWorkTrackingToolHandlers>[0]) {
  return createWorkTrackingToolHandlers(input).control_work;
}
