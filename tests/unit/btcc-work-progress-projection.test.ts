import { expect, test } from "bun:test";
import {
  projectWorkProgress,
  retiredWorkProgress,
} from
  "../../packages/butler-agent/src/agent/btcc/work-ledger/work-progress-projection.ts";

const work = { workLogicalId: "work-1", outcome: "Ship terminal truth" };
const accepted = task("task-1", 1);
const current = task("task-2", 2);
const future = task("task-3", 3);
const program = {
  planningState: "reviewed",
  programId: "program-1",
  works: [{ work, status: "active" }],
  tasks: [
    { task: accepted, status: "accepted" },
    { task: current, status: "selected" },
    { task: future, status: "planned" },
  ],
  currentWork: { work, status: "active" },
  currentTask: { task: current, status: "selected" },
} as never;

test("completed disposition never infers Work Ledger acceptance", () => {
  expect(projectWorkProgress(program, "completed").map((row) => row.taskState))
    .toEqual(["completed", "active", "planned"]);
});

for (const disposition of ["deferred", "cancelled"] as const) {
  test(`${disposition} disposition stops only the canonical current frontier`, () => {
    const rows = projectWorkProgress(program, disposition);
    expect(rows.map((row) => row.taskState)).toEqual([
      "completed",
      "stopped",
      "planned",
    ]);
    expect(rows.map((row) => row.workState)).toEqual([
      "active",
      "active",
      "active",
    ]);
  });
}

test("a reviewed Plan revision retires unfinished Tasks it replaced", () => {
  const replacement = task("task-4", 1);
  const revised = Object.assign({}, program as object, {
    tasks: [{ task: replacement, status: "selected" }],
    currentTask: { task: replacement, status: "selected" },
  }) as never;

  expect(retiredWorkProgress(program, revised).map((row) => ({
    taskId: row.taskId,
    taskState: row.taskState,
    workState: row.workState,
  }))).toEqual([
    { taskId: "task-2", taskState: "stopped", workState: "cancelled" },
    { taskId: "task-3", taskState: "stopped", workState: "cancelled" },
  ]);
});

function task(taskLogicalId: string, executionOrdinal: number) {
  return {
    taskLogicalId,
    workLogicalId: work.workLogicalId,
    intendedOutcome: `Outcome ${taskLogicalId}`,
    executionOrdinal,
  };
}
