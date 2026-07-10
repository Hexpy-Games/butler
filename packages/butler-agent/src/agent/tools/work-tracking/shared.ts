import { performWorkControl } from "../../work/work-dashboard.ts";
import { type TodoItemInput, type TodoPhase, type TodoPriority, type TodoStatus, TodoListStore } from "../../work/todo-list.ts";
import { type WorkStreamState, WorkStreamStore } from "../../work/work-stream.ts";
import { RUNTIME_SEMANTIC_TODO_LIST_ID } from "../../turn/direct-work-continuation.ts";
import {
  amendBoundWorkStreamPlan,
  assertBoundWorkStreamId,
  boundTodoListId,
  type ActiveWorkStreamBinding,
} from "./workstream-authority.ts";

type ToolCall = { args: Record<string, unknown> };

export const WORK_TRACKING_TOOL_NAMES = [
  "update_todo_list",
  "list_todo_list",
  "list_work_streams",
  "update_work_stream_state",
  "control_work",
] as const;

export function createWorkTrackingToolHandlers(input: {
  butlerData: string;
  sessionId?: string;
  originChatId?: string;
  projectId?: string;
  turnId?: string;
  todoListStore: TodoListStore;
  workStreamStore: WorkStreamStore;
  activeWorkStreamBinding?: () => ActiveWorkStreamBinding | null;
}) {
  return {
    "update_todo_list": async (call: ToolCall) => {
      const items = todoInputs(call.args.todos);
      const listId = resolvedTodoListId(call.args.list_id, input, items);
      const boundPlan = amendBoundWorkStreamPlan({
        ...input,
        items,
        title: typeof call.args.title === "string" ? call.args.title : undefined,
      });
      if (boundPlan) {
        return {
          ok: true,
          list_id: boundPlan.view.list.list_id,
          title: boundPlan.view.list.title,
          items: boundPlan.view.items,
          progress: boundPlan.view.progress,
          work_stream: boundPlan.workStream,
          plan_amendment_receipt: boundPlan.receipt,
          replayed: boundPlan.replayed,
        };
      }
      const completedReplay = completedSameTurnWorkStreamForList({
        workStreamStore: input.workStreamStore,
        sessionId: input.sessionId,
        originChatId: input.originChatId,
        projectId: input.projectId,
        listId,
        turnId: input.turnId,
        items,
      });
      if (completedReplay) {
        const view = input.todoListStore.view(listId, { includeCompleted: true });
        return {
          ok: true,
          list_id: view.list.list_id,
          title: view.list.title,
          items: view.items,
          progress: view.progress,
          work_stream: completedReplay,
          ignored: true,
          reason: "completed_work_stream_reopen_ignored",
        };
      }
      const view = input.todoListStore.update({
        listId,
        title: typeof call.args.title === "string" ? call.args.title : undefined,
        items,
      });
      const workStream = input.workStreamStore.updateFromTodoList({
        ownerSessionId: input.sessionId ?? null,
        originChatId: input.originChatId ?? null,
        projectId: input.projectId ?? null,
        listId,
        title: view.list.title ?? undefined,
        items: view.list.items,
        lastUserTurnId: input.turnId,
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
      const listId = resolvedTodoListId(call.args.list_id, input);
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
      const bound = assertBoundWorkStreamId(requestedId, input);
      const active = bound ?? (requestedId
        ? input.workStreamStore.read(requestedId)
        : input.workStreamStore.activeForSession(input.sessionId, { currentTurnId: input.turnId }));
      if (!active) {
        throw new Error("update_work_stream_state requires an active current-turn work stream or explicit work_stream_id");
      }
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

function completedSameTurnWorkStreamForList(input: {
  workStreamStore: WorkStreamStore;
  sessionId?: string;
  originChatId?: string;
  projectId?: string;
  listId: string;
  turnId?: string;
  items: TodoItemInput[];
}) {
  const turnId = input.turnId?.trim();
  if (!turnId || !hasUnfinishedTodo(input.items)) return null;
  for (const summary of input.workStreamStore.list({
    sessionId: input.sessionId,
    originChatId: input.originChatId,
    projectId: input.projectId,
    includeTerminal: true,
  })) {
    if (summary.todo_list_id !== input.listId || summary.state !== "complete") continue;
    const record = input.workStreamStore.read(summary.id);
    if (record?.last_user_turn_id === turnId) return record;
  }
  return null;
}

function hasUnfinishedTodo(items: TodoItemInput[]): boolean {
  return items.some((item) => item.status === "pending" || item.status === "in_progress");
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolvedTodoListId(
  rawListId: unknown,
  input: {
    butlerData: string;
    sessionId?: string;
    originChatId?: string;
    projectId?: string;
    turnId?: string;
    todoListStore: TodoListStore;
    workStreamStore: WorkStreamStore;
    activeWorkStreamBinding?: () => ActiveWorkStreamBinding | null;
  },
  requestedItems?: TodoItemInput[],
): string {
  const boundListId = boundTodoListId(rawListId, input);
  if (boundListId) return boundListId;
  const explicitListId = explicitTodoListId(rawListId);
  const continuation = input.workStreamStore.latestResumableForSession(input.sessionId, {
    originChatId: input.originChatId,
    projectId: input.projectId,
    excludeTodoListIds: [RUNTIME_SEMANTIC_TODO_LIST_ID],
  });
  const continuationListId = continuation?.todo_list_id?.trim();
  if (explicitListId && explicitListId !== continuationListId) return explicitListId;
  if (continuationListId && requestedItems) {
    if (requestedTodosPreserveContinuation({
      todoListStore: input.todoListStore,
      listId: continuationListId,
      requestedItems,
    })) {
      return continuationListId;
    }
    throw new Error(
      "A recoverable WorkStream already has open todo items. Update that existing list by keeping its open todo ids, or start unrelated work with an explicit non-main list_id.",
    );
  }
  if (explicitListId) return explicitListId;
  if (continuationListId && !requestedItems) return continuationListId;
  return turnScopedMainTodoListId(input.turnId);
}

function requestedTodosPreserveContinuation(input: {
  todoListStore: TodoListStore;
  listId: string;
  requestedItems: TodoItemInput[];
}): boolean {
  const record = input.todoListStore.read(input.listId);
  if (!record) return false;
  const requestedById = new Map(input.requestedItems
    .filter((item): item is TodoItemInput & { id: string } => Boolean(item.id))
    .map((item) => [item.id, item]));
  const existingIds = record.items
    .filter((item) => item.status !== "cancelled")
    .map((item) => item.id);
  if (existingIds.length === 0) return false;
  if (input.requestedItems.some((item) => !item.id || !existingIds.includes(item.id))) {
    return false;
  }
  if (existingIds.some((id) => !requestedById.has(id))) return false;
  return record.items
    .filter((item) => item.status === "pending" || item.status === "in_progress")
    .every((item) => {
      const requested = requestedById.get(item.id);
      return Boolean(
        requested &&
        requested.content.trim() === item.content &&
        requested.active_form.trim() === item.active_form &&
        (requested.phase ?? null) === item.phase,
      );
    });
}

function explicitTodoListId(rawListId: unknown): string | null {
  if (typeof rawListId !== "string") return null;
  const trimmed = rawListId.trim();
  if (!trimmed || trimmed === "main") return null;
  return trimmed;
}

function turnScopedMainTodoListId(turnId?: string): string {
  if (!turnId?.trim()) return "main";
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
