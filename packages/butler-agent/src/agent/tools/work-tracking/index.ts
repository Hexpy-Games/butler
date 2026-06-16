import { createUpdateTodoListToolHandler } from "./update_todo_list/executor.ts";
import { createListTodoListToolHandler } from "./list_todo_list/executor.ts";
import { createListWorkStreamsToolHandler } from "./list_work_streams/executor.ts";
import { createUpdateWorkStreamStateToolHandler } from "./update_work_stream_state/executor.ts";
import { createControlWorkToolHandler } from "./control_work/executor.ts";

export function createWorkTrackingToolHandlers(input: Parameters<typeof createUpdateTodoListToolHandler>[0]) {
  return {
    "update_todo_list": createUpdateTodoListToolHandler(input),
    "list_todo_list": createListTodoListToolHandler(input),
    "list_work_streams": createListWorkStreamsToolHandler(input),
    "update_work_stream_state": createUpdateWorkStreamStateToolHandler(input),
    "control_work": createControlWorkToolHandler(input),
  };
}
