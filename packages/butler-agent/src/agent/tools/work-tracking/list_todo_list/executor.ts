import { createWorkTrackingToolHandlers } from "../shared.ts";

export function createListTodoListToolHandler(input: Parameters<typeof createWorkTrackingToolHandlers>[0]) {
  return createWorkTrackingToolHandlers(input).list_todo_list;
}
