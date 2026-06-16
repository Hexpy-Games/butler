import { performWorkControl } from "../../work/work-dashboard.ts";
import { type TodoItemInput, type TodoPhase, type TodoPriority, type TodoStatus, TodoListStore } from "../../work/todo-list.ts";
import { type WorkStreamState, WorkStreamStore } from "../../work/work-stream.ts";

type ToolCall = { args: Record<string, unknown> };

export function createWorkTrackingToolHandlers(input: {
  butlerData: string;
  sessionId?: string;
  projectId?: string;
  turnId?: string;
  todoListStore: TodoListStore;
  workStreamStore: WorkStreamStore;
}) {
  return {
    "update_todo_list": async (call: ToolCall) => {
      const listId = scopedTodoListId(call.args.list_id, input.turnId);
      const view = input.todoListStore.update({
        listId,
        title: typeof call.args.title === "string" ? call.args.title : undefined,
        items: todoInputs(call.args.todos),
      });
      const workStream = input.workStreamStore.updateFromTodoList({
        ownerSessionId: input.sessionId ?? null,
        projectId: input.projectId ?? null,
        listId,
        title: view.list.title ?? undefined,
        items: view.list.items,
      });
      return {
        ok: true,
        list_id: view.list.list_id,
        title: view.list.title,
        items: view.items,
        progress: view.progress,
        work_stream: workStream,
      };
    },
    "list_todo_list": async (call: ToolCall) => {
      const listId = scopedTodoListId(call.args.list_id, input.turnId);
      const view = input.todoListStore.view(
        listId,
        { includeCompleted: call.args.include_completed === true },
      );
      return {
        ok: true,
        list_id: view.list.list_id,
        title: view.list.title,
        updated_at: view.list.updated_at,
        items: view.items,
        progress: view.progress,
      };
    },
    "list_work_streams": async (call: ToolCall) => {
      const sessionId = typeof call.args.session_id === "string" && call.args.session_id.trim()
        ? call.args.session_id.trim()
        : input.sessionId;
      const projectId = typeof call.args.project_id === "string" && call.args.project_id.trim()
        ? call.args.project_id.trim()
        : undefined;
      return {
        ok: true,
        work_streams: input.workStreamStore.list({
          sessionId,
          projectId,
          includeTerminal: call.args.include_terminal === true,
        }),
      };
    },
    "update_work_stream_state": async (call: ToolCall) => {
      const requestedId = typeof call.args.work_stream_id === "string" && call.args.work_stream_id.trim()
        ? call.args.work_stream_id.trim()
        : undefined;
      const active = requestedId ? input.workStreamStore.read(requestedId) : input.workStreamStore.activeForSession(input.sessionId);
      if (!active) throw new Error("update_work_stream_state requires an active work stream");
      return {
        ok: true,
        work_stream: input.workStreamStore.transition({
          id: active.id,
          state: workStreamState(call.args.state),
          activeStepId: typeof call.args.active_step_id === "string" ? call.args.active_step_id : undefined,
          statusNote: typeof call.args.status_note === "string" ? call.args.status_note : undefined,
        }),
      };
    },
    "control_work": async (call: ToolCall) => {
      const action = typeof call.args.action === "string" ? call.args.action.trim() : "";
      if (
        action !== "view_result" &&
        action !== "resume" &&
        action !== "retry_delivery" &&
        action !== "cancel"
      ) {
        throw new Error("control_work requires a valid action");
      }
      return performWorkControl({
        butlerData: input.butlerData,
        action,
        taskId: typeof call.args.task_id === "string" ? call.args.task_id : undefined,
        notificationId: typeof call.args.notification_id === "string" ? call.args.notification_id : undefined,
      });
    },
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function scopedTodoListId(rawListId: unknown, turnId?: string): string {
  const listId = typeof rawListId === "string" && rawListId.trim()
    ? rawListId.trim()
    : "main";
  if (listId !== "main" || !turnId?.trim()) return listId;
  const safeTurnId = turnId.trim().replace(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 70);
  return ((safeTurnId || "turn") + ":main").slice(0, 80);
}

function todoStatus(value: unknown): TodoStatus {
  if (
    value === "pending" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new Error("todo status must be pending, in_progress, completed, or cancelled");
}

function todoPriority(value: unknown): TodoPriority | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "low" || value === "normal" || value === "high") return value;
  throw new Error("todo priority must be low, normal, or high");
}

function todoPhase(value: unknown): TodoPhase | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    value === "conception" ||
    value === "planning" ||
    value === "execution" ||
    value === "review" ||
    value === "consolidation" ||
    value === "reporting"
  ) {
    return value;
  }
  throw new Error("todo phase must be conception, planning, execution, review, consolidation, or reporting");
}

function todoInputs(value: unknown): TodoItemInput[] {
  if (!Array.isArray(value)) throw new Error("update_todo_list requires todos");
  return value.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("todo item must be an object");
    }
    const input = item as Record<string, unknown>;
    return {
      id: typeof input.id === "string" ? input.id : undefined,
      content: typeof input.content === "string" ? input.content : "",
      active_form: typeof input.active_form === "string" ? input.active_form : "",
      status: todoStatus(input.status),
      phase: todoPhase(input.phase),
      priority: todoPriority(input.priority),
      blocked_by: stringArray(input.blocked_by),
      note: typeof input.note === "string" ? input.note : undefined,
    };
  });
}

function workStreamState(value: unknown): WorkStreamState {
  if (
    value === "routing" ||
    value === "conception" ||
    value === "planning" ||
    value === "executing" ||
    value === "reviewing" ||
    value === "consolidating" ||
    value === "reporting" ||
    value === "waiting_user" ||
    value === "paused" ||
    value === "complete" ||
    value === "failed" ||
    value === "recoverable" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new Error("work stream state is invalid");
}
