import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  applyTurnLocalWorkOutcomeForSession,
  assertWorkStreamTransition,
  completeTurnLocalWorkStreamForSession,
  WorkStreamStore,
} from "../../packages/butler-agent/src/agent/work/work-stream.ts";
import { TodoListStore, type TodoItem, type TodoItemInput } from "../../packages/butler-agent/src/agent/work/todo-list.ts";

let tempDir = "";

beforeEach(() => {
  tempDir = join(tmpdir(), `butler-work-stream-${Date.now()}-${Math.random()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function todo(input: Partial<TodoItem> & Pick<TodoItem, "id" | "phase" | "status">): TodoItem {
  return {
    id: input.id,
    content: input.content ?? input.id,
    active_form: input.active_form ?? `Doing ${input.id}`,
    status: input.status,
    phase: input.phase,
    priority: "normal",
    blocked_by: [],
    note: null,
    created_at: "2026-05-15T00:00:00.000Z",
    updated_at: "2026-05-15T00:00:00.000Z",
    completed_at: input.status === "completed" ? "2026-05-15T00:00:00.000Z" : null,
  };
}

function todoInput(
  input: Partial<TodoItemInput> & {
    id: string;
    phase: NonNullable<TodoItemInput["phase"]>;
    status: TodoItemInput["status"];
  },
): TodoItemInput {
  return {
    id: input.id,
    content: input.content ?? input.id,
    active_form: input.active_form ?? `Doing ${input.id}`,
    status: input.status,
    phase: input.phase,
    priority: "normal",
    blocked_by: [],
    note: input.note,
  };
}

test("work stream transitions reject skipped review and completion claims", () => {
  expect(() => assertWorkStreamTransition("planning", "complete")).toThrow(
    "invalid work stream transition planning -> complete",
  );
  expect(() => assertWorkStreamTransition("executing", "reporting")).toThrow(
    "invalid work stream transition executing -> reporting",
  );
  expect(() => assertWorkStreamTransition("reviewing", "executing")).not.toThrow();
});

test("todo progress creates a durable session-scoped work stream", () => {
  const store = new WorkStreamStore(tempDir);
  const record = store.updateFromTodoList({
    ownerSessionId: "butler/app-project-butler",
    projectId: "butler",
    listId: "main",
    title: "Ship WorkStream FSM",
    intentSummary: "Make Butler route complex work through issue-level state.",
    expectedDeliverable: "A validated runtime behavior change.",
    items: [
      todo({ id: "intent", phase: "conception", status: "completed" }),
      todo({ id: "plan", phase: "planning", status: "completed" }),
      todo({ id: "code", phase: "execution", status: "in_progress" }),
    ],
    now: new Date("2026-05-15T01:00:00.000Z"),
  });

  expect(existsSync(join(tempDir, "work-streams", `${record.id}.json`))).toBe(true);
  expect(record).toMatchObject({
    title: "Ship WorkStream FSM",
    owner_session_id: "butler/app-project-butler",
    project_id: "butler",
    state: "executing",
    current_phase: "execution",
    active_step_id: "code",
  });
  expect(store.list({ sessionId: "butler/app-project-butler" }).map((item) => item.id)).toEqual([record.id]);
});

test("todo-derived work streams accept sparse active phase snapshots", () => {
  const store = new WorkStreamStore(tempDir);

  const reporting = store.updateFromTodoList({
    ownerSessionId: "butler/app-project-butler",
    listId: "main",
    items: [
      todo({ id: "intent", phase: "conception", status: "completed" }),
      todo({ id: "report", phase: "reporting", status: "in_progress" }),
    ],
  });
  expect(reporting).toMatchObject({
    state: "reporting",
    current_phase: "reporting",
    active_step_id: "report",
  });

  const executing = store.updateFromTodoList({
    ownerSessionId: "butler/app-project-butler",
    listId: "issue-b",
    items: [
      todo({ id: "intent", phase: "conception", status: "completed" }),
      todo({ id: "code", phase: "execution", status: "in_progress" }),
    ],
  });
  expect(executing).toMatchObject({
    state: "executing",
    current_phase: "execution",
    active_step_id: "code",
  });
});

test("work streams can re-enter execution from review without blocking unrelated streams", () => {
  const store = new WorkStreamStore(tempDir);
  const a = store.updateFromTodoList({
    ownerSessionId: "butler/app-project-butler",
    projectId: "butler",
    listId: "issue-a",
    items: [
      todo({ id: "intent", phase: "conception", status: "completed" }),
      todo({ id: "plan", phase: "planning", status: "completed" }),
      todo({ id: "code", phase: "execution", status: "completed" }),
      todo({ id: "review", phase: "review", status: "in_progress" }),
    ],
  });
  const waiting = store.transition({ id: a.id, state: "waiting_user" });
  expect(waiting.state).toBe("waiting_user");

  const b = store.updateFromTodoList({
    ownerSessionId: "butler/app-project-butler",
    projectId: "butler",
    listId: "issue-b",
    items: [
      todo({ id: "intent", phase: "conception", status: "completed" }),
      todo({ id: "plan", phase: "planning", status: "in_progress" }),
    ],
  });

  expect(store.list({ sessionId: "butler/app-project-butler" }).map((item) => item.id).sort()).toEqual(
    [a.id, b.id].sort(),
  );

  const resumed = store.transition({ id: waiting.id, state: "executing" });
  expect(resumed.state).toBe("executing");
  expect(resumed.current_phase).toBe("execution");
});

test("active projection excludes recovery states and historical waiting turns", () => {
  const store = new WorkStreamStore(tempDir);
  const sessionId = "butler/app-project-butler";
  const recoverable = store.updateFromTodoList({
    ownerSessionId: sessionId,
    listId: "recoverable-turn",
    lastUserTurnId: "turn-recoverable",
    items: [
      todo({ id: "code", phase: "execution", status: "in_progress" }),
    ],
    now: new Date("2026-05-15T01:00:00.000Z"),
  });
  store.transition({
    id: recoverable.id,
    state: "recoverable",
    now: new Date("2026-05-15T01:01:00.000Z"),
  });
  const paused = store.updateFromTodoList({
    ownerSessionId: sessionId,
    listId: "paused-turn",
    lastUserTurnId: "turn-paused",
    items: [
      todo({ id: "review", phase: "review", status: "in_progress" }),
    ],
    now: new Date("2026-05-15T01:02:00.000Z"),
  });
  store.transition({
    id: paused.id,
    state: "paused",
    now: new Date("2026-05-15T01:03:00.000Z"),
  });
  const waiting = store.updateFromTodoList({
    ownerSessionId: sessionId,
    listId: "waiting-turn",
    lastUserTurnId: "turn-waiting",
    items: [
      todo({ id: "plan", phase: "planning", status: "in_progress" }),
    ],
    now: new Date("2026-05-15T01:04:00.000Z"),
  });
  store.transition({
    id: waiting.id,
    state: "waiting_user",
    now: new Date("2026-05-15T01:05:00.000Z"),
  });

  expect(store.activeForSession(sessionId)).toBeNull();
  expect(store.activeForSession(sessionId, { currentTurnId: "turn-other" })).toBeNull();
  expect(store.listActive({ sessionId })).toEqual([]);
  expect(store.activeForSession(sessionId, { currentTurnId: "turn-waiting" })?.id)
    .toBe(waiting.id);
  expect(store.list({ sessionId }).map((item) => item.state).sort()).toEqual([
    "paused",
    "recoverable",
    "waiting_user",
  ]);
});

test("todo updates reuse same-turn waiting revision after terminal base stream", () => {
  const store = new WorkStreamStore(tempDir);
  const sessionId = "butler/app-project-butler";
  const completed = store.updateFromTodoList({
    ownerSessionId: sessionId,
    listId: "same-turn",
    lastUserTurnId: "turn-current",
    items: [
      todo({ id: "report", phase: "reporting", status: "completed" }),
    ],
    now: new Date("2026-05-15T01:00:00.000Z"),
  });
  expect(completed.state).toBe("complete");
  const revision = store.updateFromTodoList({
    ownerSessionId: sessionId,
    listId: "same-turn",
    lastUserTurnId: "turn-current",
    items: [
      todo({ id: "decide", phase: "planning", status: "in_progress" }),
    ],
    now: new Date("2026-05-15T01:01:00.000Z"),
  });
  store.transition({
    id: revision.id,
    state: "waiting_user",
    now: new Date("2026-05-15T01:02:00.000Z"),
  });

  const resumed = store.updateFromTodoList({
    ownerSessionId: sessionId,
    listId: "same-turn",
    lastUserTurnId: "turn-current",
    items: [
      todo({ id: "decide", phase: "planning", status: "in_progress" }),
    ],
    now: new Date("2026-05-15T01:03:00.000Z"),
  });

  expect(resumed.id).toBe(revision.id);
  expect(store.list({ sessionId, includeTerminal: true })
    .map((item) => item.id)
    .filter((id) => id !== completed.id)).toEqual([revision.id]);
});

test("turn-local recoverable outcome clears active todos without touching linked streams", () => {
  const store = new WorkStreamStore(tempDir);
  const todoStore = new TodoListStore(tempDir);
  const sessionId = "butler/app-project-butler";
  const turnLocalTodos = todoStore.update({
    listId: "turn-local-recoverable",
    items: [
      todoInput({ id: "inspect", phase: "execution", status: "in_progress" }),
      todoInput({ id: "report", phase: "reporting", status: "pending" }),
    ],
  });
  const turnLocal = store.updateFromTodoList({
    ownerSessionId: sessionId,
    listId: "turn-local-recoverable",
    lastUserTurnId: "turn-recoverable",
    items: turnLocalTodos.list.items,
  });
  const linkedTodos = todoStore.update({
    listId: "linked-worker",
    items: [
      todoInput({ id: "worker", phase: "execution", status: "in_progress" }),
    ],
  });
  const linked = store.updateFromTodoList({
    ownerSessionId: sessionId,
    listId: "linked-worker",
    lastUserTurnId: "turn-recoverable",
    items: linkedTodos.list.items,
  });
  store.link({ id: linked.id, workerTaskIds: ["task-worker"] });

  const updated = applyTurnLocalWorkOutcomeForSession({
    butlerData: tempDir,
    sessionId,
    turnId: "turn-recoverable",
    outcome: "recoverable",
    statusNote: "Interrupted before final delivery.",
  });

  expect(updated.map((item) => item.id)).toEqual([turnLocal.id]);
  expect(store.read(turnLocal.id)).toMatchObject({
    state: "recoverable",
    current_phase: "execution",
    active_step_id: "inspect",
    status_note: "Interrupted before final delivery.",
  });
  expect(new TodoListStore(tempDir).view("turn-local-recoverable", { includeCompleted: true }).progress.active)
    .toBe(0);
  expect(store.activeForSession(sessionId, { currentTurnId: "turn-recoverable" })?.id)
    .toBe(linked.id);
  expect(store.read(linked.id)).toMatchObject({
    state: "executing",
    linked_worker_task_ids: ["task-worker"],
  });
});

test("turn-local terminal outcomes clear active todos and active projection", () => {
  const store = new WorkStreamStore(tempDir);
  const todoStore = new TodoListStore(tempDir);
  const sessionId = "butler/app-project-butler";
  const completedTodos = todoStore.update({
    listId: "turn-local-completed",
    items: [
      todoInput({ id: "report", phase: "reporting", status: "in_progress" }),
    ],
  });
  const completed = store.updateFromTodoList({
    ownerSessionId: sessionId,
    listId: "turn-local-completed",
    lastUserTurnId: "turn-completed",
    items: completedTodos.list.items,
  });
  const cancelledTodos = todoStore.update({
    listId: "turn-local-cancelled",
    items: [
      todoInput({ id: "inspect", phase: "execution", status: "in_progress" }),
    ],
  });
  const cancelled = store.updateFromTodoList({
    ownerSessionId: sessionId,
    listId: "turn-local-cancelled",
    lastUserTurnId: "turn-cancelled",
    items: cancelledTodos.list.items,
  });

  applyTurnLocalWorkOutcomeForSession({
    butlerData: tempDir,
    sessionId,
    turnId: "turn-completed",
    outcome: "completed",
    statusNote: "Final answer delivered.",
  });
  applyTurnLocalWorkOutcomeForSession({
    butlerData: tempDir,
    sessionId,
    turnId: "turn-cancelled",
    outcome: "cancelled",
    statusNote: "Turn cancelled.",
  });

  expect(store.read(completed.id)).toMatchObject({
    state: "complete",
    current_phase: null,
    active_step_id: null,
  });
  expect(store.read(cancelled.id)).toMatchObject({
    state: "cancelled",
    current_phase: null,
    active_step_id: null,
  });
  expect(new TodoListStore(tempDir).view("turn-local-completed", { includeCompleted: true }).progress)
    .toMatchObject({ active: 0, completed: 1 });
  expect(new TodoListStore(tempDir).view("turn-local-cancelled", { includeCompleted: true }).progress)
    .toMatchObject({ active: 0, cancelled: 1 });
  expect(store.activeForSession(sessionId, { currentTurnId: "turn-completed" })).toBeNull();
  expect(store.activeForSession(sessionId, { currentTurnId: "turn-cancelled" })).toBeNull();
});

test("resumed todo progress preserves terminal streams and opens an active revision", () => {
  const store = new WorkStreamStore(tempDir);
  const completed = store.updateFromTodoList({
    ownerSessionId: "butler/app-project-butler",
    projectId: "butler",
    listId: "durable-turn",
    title: "Durable turn",
    items: [
      todo({ id: "inspect", phase: "execution", status: "completed" }),
      todo({ id: "report", phase: "reporting", status: "completed" }),
    ],
    now: new Date("2026-05-15T01:00:00.000Z"),
  });

  expect(completed.state).toBe("complete");
  store.link({
    id: completed.id,
    plannedTaskIds: ["planned-durable"],
    orchestrationIds: ["orch-durable"],
    workerTaskIds: ["worker-durable"],
  });

  const resumed = store.updateFromTodoList({
    ownerSessionId: "butler/app-project-butler",
    projectId: "butler",
    listId: "durable-turn",
    title: "Durable turn retry",
    items: [
      todo({ id: "inspect", phase: "execution", status: "in_progress" }),
      todo({ id: "report", phase: "reporting", status: "pending" }),
    ],
    now: new Date("2026-05-15T01:05:00.000Z"),
  });

  expect(resumed.id).not.toBe(completed.id);
  expect(resumed).toMatchObject({
    state: "executing",
    current_phase: "execution",
    active_step_id: "inspect",
    todo_list_id: "durable-turn",
    linked_planned_task_ids: ["planned-durable"],
    linked_orchestration_ids: ["orch-durable"],
    linked_worker_task_ids: ["worker-durable"],
  });
  expect(store.read(completed.id)?.state).toBe("complete");
  expect(store.list({ sessionId: "butler/app-project-butler" }).map((item) => item.id)).toEqual([resumed.id]);
  expect(store.list({ sessionId: "butler/app-project-butler", includeTerminal: true })
    .map((item) => item.state)
    .sort()).toEqual(["complete", "executing"]);
});

test("todo completion clears stale recoverable status notes", () => {
  const store = new WorkStreamStore(tempDir);
  const active = store.updateFromTodoList({
    ownerSessionId: "butler/app-project-butler",
    projectId: "butler",
    listId: "recoverable-turn",
    title: "Recoverable turn",
    items: [
      todo({ id: "inspect", phase: "execution", status: "in_progress" }),
      todo({ id: "report", phase: "reporting", status: "pending" }),
    ],
  });
  store.transition({
    id: active.id,
    state: "recoverable",
    statusNote: "Turn interrupted before final delivery.",
  });

  const completed = store.updateFromTodoList({
    ownerSessionId: "butler/app-project-butler",
    projectId: "butler",
    listId: "recoverable-turn",
    title: "Recoverable turn",
    items: [
      todo({ id: "inspect", phase: "execution", status: "completed" }),
      todo({ id: "report", phase: "reporting", status: "completed" }),
    ],
  });

  expect(completed).toMatchObject({
    state: "complete",
    status_note: null,
  });
});

test("work streams link planned tasks orchestrations and worker tasks to the active stream", () => {
  const store = new WorkStreamStore(tempDir);
  const stream = store.updateFromTodoList({
    ownerSessionId: "butler/app-project-butler",
    listId: "main",
    items: [
      todo({ id: "intent", phase: "conception", status: "completed" }),
      todo({ id: "plan", phase: "planning", status: "completed" }),
      todo({ id: "code", phase: "execution", status: "in_progress" }),
    ],
  });

  const linked = store.link({
    sessionId: "butler/app-project-butler",
    plannedTaskIds: ["planned-1"],
    orchestrationIds: ["orchestration-1"],
    workerTaskIds: ["worker-1"],
  });

  expect(linked?.id).toBe(stream.id);
  expect(linked?.linked_planned_task_ids).toEqual(["planned-1"]);
  expect(linked?.linked_orchestration_ids).toEqual(["orchestration-1"]);
  expect(linked?.linked_worker_task_ids).toEqual(["worker-1"]);
});

test("linked work stream cancellation is terminal and preserves linked ids", () => {
  const store = new WorkStreamStore(tempDir);
  const stream = store.updateFromTodoList({
    ownerSessionId: "butler/app-project-butler",
    listId: "main",
    items: [
      todo({ id: "intent", phase: "conception", status: "completed" }),
      todo({ id: "code", phase: "execution", status: "in_progress" }),
    ],
  });
  store.link({
    id: stream.id,
    plannedTaskIds: ["planned-1"],
    orchestrationIds: ["orchestration-1"],
    workerTaskIds: ["worker-1", "worker-2"],
  });

  const cancelled = store.cancelLinked({
    workerTaskIds: ["worker-1"],
    statusNote: "Cancelled from worker control.",
    now: new Date("2026-05-15T03:00:00.000Z"),
  });

  expect(cancelled).toHaveLength(1);
  expect(cancelled[0]).toMatchObject({
    id: stream.id,
    state: "cancelled",
    current_phase: null,
    active_step_id: null,
    status_note: "Cancelled from worker control.",
    linked_planned_task_ids: ["planned-1"],
    linked_orchestration_ids: ["orchestration-1"],
    linked_worker_task_ids: ["worker-1", "worker-2"],
  });
  expect(store.list({ sessionId: "butler/app-project-butler" })).toEqual([]);
  expect(store.list({ sessionId: "butler/app-project-butler", includeTerminal: true })[0])
    .toMatchObject({ state: "cancelled", terminal: true });
});

test("final delivery completes only unlinked turn-local work streams", () => {
  const store = new WorkStreamStore(tempDir);
  const turnLocal = store.updateFromTodoList({
    ownerSessionId: "butler/app-chat",
    listId: "main",
    items: [
      todo({ id: "check-info", phase: "planning", status: "completed" }),
      todo({ id: "report", phase: "reporting", status: "in_progress" }),
    ],
  });
  const completed = completeTurnLocalWorkStreamForSession({
    butlerData: tempDir,
    sessionId: "butler/app-chat",
    statusNote: "Final answer delivered.",
    now: new Date("2026-05-15T02:00:00.000Z"),
  });

  expect(completed).toMatchObject({
    id: turnLocal.id,
    state: "complete",
    current_phase: null,
    active_step_id: null,
    status_note: "Final answer delivered.",
  });

  const unfinished = store.updateFromTodoList({
    ownerSessionId: "butler/app-chat-unfinished",
    listId: "main",
    items: [
      todo({ id: "implement", phase: "execution", status: "in_progress" }),
    ],
  });
  const notCompleted = completeTurnLocalWorkStreamForSession({
    butlerData: tempDir,
    sessionId: "butler/app-chat-unfinished",
    statusNote: "Final answer delivered.",
  });

  expect(notCompleted).toMatchObject({
    id: unfinished.id,
    state: "executing",
    active_step_id: "implement",
  });

  const linked = store.updateFromTodoList({
    ownerSessionId: "butler/app-chat-linked",
    listId: "main",
    items: [
      todo({ id: "worker", phase: "execution", status: "in_progress" }),
    ],
  });
  store.link({ id: linked.id, workerTaskIds: ["task-worker"] });
  const stillActive = completeTurnLocalWorkStreamForSession({
    butlerData: tempDir,
    sessionId: "butler/app-chat-linked",
  });

  expect(stillActive).toMatchObject({
    id: linked.id,
    state: "executing",
    active_step_id: "worker",
    linked_worker_task_ids: ["task-worker"],
  });
});
