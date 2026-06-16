import { createWorkTrackingToolHandlers } from "../shared.ts";

export function createUpdateTodoListToolHandler(input: Parameters<typeof createWorkTrackingToolHandlers>[0]) {
  return createWorkTrackingToolHandlers(input).update_todo_list;
}
