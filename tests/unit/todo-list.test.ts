import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { TodoListStore } from "../../packages/butler-agent/src/agent/work/todo-list.ts";

let tempDir = "";

beforeEach(() => {
  tempDir = join(tmpdir(), `butler-todo-list-${Date.now()}-${Math.random()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("todo lists persist only under Butler data", () => {
  const store = new TodoListStore(tempDir);

  const view = store.update({
    listId: "main",
    title: "Ship core capability",
    now: new Date("2026-04-27T00:00:00.000Z"),
    items: [
      {
        content: "Write the governing spec",
        active_form: "Writing the governing spec",
        status: "completed",
        phase: "conception",
      },
      {
        content: "Implement the todo store",
        active_form: "Implementing the todo store",
        status: "in_progress",
        phase: "execution",
        priority: "high",
      },
    ],
  });

  expect(existsSync(join(tempDir, "todos", "main.json"))).toBe(true);
  expect(view.list.title).toBe("Ship core capability");
  expect(view.progress).toMatchObject({
    total: 2,
    completed: 1,
    in_progress: 1,
    pending: 0,
    progress_pct: 50,
  });
  expect(view.progress.current?.content).toBe("Implement the todo store");
  expect(view.list.items.map((item) => item.phase)).toEqual(["conception", "execution"]);
});

test("todo lists validate active forms and single in-progress item", () => {
  const store = new TodoListStore(tempDir);

  expect(() => store.update({
    items: [
      { content: "Write tests", active_form: "", status: "pending" },
    ],
  })).toThrow("todo active_form must be non-empty");

  expect(() => store.update({
    items: [
      { content: "Write tests", active_form: "Writing tests", status: "in_progress" },
      { content: "Implement", active_form: "Implementing", status: "in_progress" },
    ],
  })).toThrow("at most one in_progress");

  expect(() => store.update({
    items: [
      {
        content: "Write tests",
        active_form: "Writing tests",
        status: "pending",
        phase: "sleeping" as never,
      },
    ],
  })).toThrow("unsupported todo phase");
});

test("todo lists allow empty lists and reject oversized lists", () => {
  const store = new TodoListStore(tempDir);

  const empty = store.update({
    listId: "main",
    items: [],
  });
  expect(empty.progress).toMatchObject({
    total: 0,
    active: 0,
    progress_pct: 100,
  });

  expect(() => store.update({
    items: Array.from({ length: 101 }, (_, index) => ({
      id: `item-${index}`,
      content: `Todo ${index}`,
      active_form: `Doing todo ${index}`,
      status: "pending" as const,
    })),
  })).toThrow("todo list may contain at most 100 items");
});

test("listing hides completed items by default and can include them", () => {
  const store = new TodoListStore(tempDir);
  store.update({
    listId: "feature",
    items: [
      { id: "spec", content: "Write spec", active_form: "Writing spec", status: "completed" },
      { id: "tests", content: "Write tests", active_form: "Writing tests", status: "pending" },
      { id: "old", content: "Drop obsolete path", active_form: "Dropping obsolete path", status: "cancelled" },
    ],
  });

  expect(store.view("feature").items.map((item) => item.id)).toEqual(["tests"]);
  expect(store.view("feature", { includeCompleted: true }).items.map((item) => item.id)).toEqual([
    "spec",
    "tests",
    "old",
  ]);
  expect(store.listIds()).toEqual(["feature"]);
});

test("todo lists reject duplicate ids with a useful index", () => {
  const store = new TodoListStore(tempDir);

  expect(() => store.update({
    items: [
      { id: "spec", content: "Write spec", active_form: "Writing spec", status: "pending" },
      { id: "spec", content: "Review spec", active_form: "Reviewing spec", status: "pending" },
    ],
  })).toThrow("duplicate todo id at index 1: spec");
});

test("todo lists validate blocked_by references", () => {
  const store = new TodoListStore(tempDir);

  expect(() => store.update({
    items: [
      {
        id: "tests",
        content: "Write tests",
        active_form: "Writing tests",
        status: "pending",
        blocked_by: ["spec"],
      },
    ],
  })).toThrow("unknown blocked_by id: spec");

  expect(() => store.update({
    items: [
      {
        id: "spec",
        content: "Write spec",
        active_form: "Writing spec",
        status: "pending",
        blocked_by: ["spec"],
      },
    ],
  })).toThrow("cannot block itself: spec");

  const view = store.update({
    items: [
      { id: "spec", content: "Write spec", active_form: "Writing spec", status: "completed" },
      {
        id: "tests",
        content: "Write tests",
        active_form: "Writing tests",
        status: "pending",
        blocked_by: ["spec"],
      },
    ],
  });

  expect(view.list.items[1]?.blocked_by).toEqual(["spec"]);
});

test("todo lists reject blocked_by dependency cycles", () => {
  const store = new TodoListStore(tempDir);

  expect(() => store.update({
    items: [
      {
        id: "spec",
        content: "Write spec",
        active_form: "Writing spec",
        status: "pending",
        blocked_by: ["review"],
      },
      {
        id: "review",
        content: "Review spec",
        active_form: "Reviewing spec",
        status: "pending",
        blocked_by: ["spec"],
      },
    ],
  })).toThrow("dependency cycle detected");
});

test("todo progress excludes cancelled items from completion denominator", () => {
  const store = new TodoListStore(tempDir);

  const view = store.update({
    items: [
      { id: "done", content: "Finish accepted work", active_form: "Finishing accepted work", status: "completed" },
      { id: "dropped", content: "Drop obsolete work", active_form: "Dropping obsolete work", status: "cancelled" },
    ],
  });

  expect(view.progress).toMatchObject({
    total: 2,
    completed: 1,
    cancelled: 1,
    progress_pct: 100,
  });
});

test("todo completion timestamps reflect completion transitions", () => {
  const store = new TodoListStore(tempDir);

  store.update({
    now: new Date("2026-04-27T00:00:00.000Z"),
    items: [
      { id: "spec", content: "Write spec", active_form: "Writing spec", status: "completed" },
    ],
  });
  expect(store.view("main", { includeCompleted: true }).list.items[0]?.completed_at)
    .toBe("2026-04-27T00:00:00.000Z");

  store.update({
    now: new Date("2026-04-27T00:10:00.000Z"),
    items: [
      { id: "spec", content: "Write spec", active_form: "Writing spec", status: "pending" },
    ],
  });
  expect(store.view("main", { includeCompleted: true }).list.items[0]?.completed_at).toBeNull();

  store.update({
    now: new Date("2026-04-27T00:20:00.000Z"),
    items: [
      { id: "spec", content: "Write spec", active_form: "Writing spec", status: "completed" },
    ],
  });
  expect(store.view("main", { includeCompleted: true }).list.items[0]?.completed_at)
    .toBe("2026-04-27T00:20:00.000Z");

  store.update({
    now: new Date("2026-04-27T00:30:00.000Z"),
    items: [
      { id: "spec", content: "Write spec", active_form: "Writing spec", status: "completed" },
    ],
  });
  expect(store.view("main", { includeCompleted: true }).list.items[0]?.completed_at)
    .toBe("2026-04-27T00:20:00.000Z");
});
