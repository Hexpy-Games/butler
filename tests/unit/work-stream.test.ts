import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  assertWorkStreamTransition,
  completeTurnLocalWorkStreamForSession,
  WorkStreamStore,
} from "../../packages/butler-agent/src/agent/work/work-stream.ts";
import type { TodoItem } from "../../packages/butler-agent/src/agent/work/todo-list.ts";

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

test("final delivery completes only unlinked turn-local work streams", () => {
  const store = new WorkStreamStore(tempDir);
  const turnLocal = store.updateFromTodoList({
    ownerSessionId: "butler/app-chat",
    listId: "main",
    items: [
      todo({ id: "check-info", phase: "planning", status: "in_progress" }),
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
