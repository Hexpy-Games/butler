import { createWorkTrackingToolHandlers } from "../shared.ts";

export function createListWorkStreamsToolHandler(input: Parameters<typeof createWorkTrackingToolHandlers>[0]) {
  return createWorkTrackingToolHandlers(input).list_work_streams;
}
