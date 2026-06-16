import { createWorkTrackingToolHandlers } from "../shared.ts";

export function createUpdateWorkStreamStateToolHandler(input: Parameters<typeof createWorkTrackingToolHandlers>[0]) {
  return createWorkTrackingToolHandlers(input).update_work_stream_state;
}
