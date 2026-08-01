import { expect, test } from "bun:test";
import { runProjectLedgerPlannedLifecycleMutation } from "../../packages/butler-agent/src/agent/tools/project-ledger/lifecycle-planner.ts";

const executor = { butlerHome: "/tmp/butler", butlerData: "/tmp/butler-data" };
const projectPath = "/tmp/butler-data/project-ledger/projects/butler";

test("Project Ledger planner refreshes and replans once after stale task transition", () => {
  const calls: string[] = [];
  let showCount = 0;
  const result = runProjectLedgerPlannedLifecycleMutation({
    executor,
    toolName: "project_ledger_task_complete",
    args: { id: "T-STALE", validation: "tested", review: "reviewed", report: "reports/t.md" },
    projectPath,
    finalCliArgs: ["task", "complete", "--project", projectPath, "--id", "T-STALE"],
    runTool: (_input, args) => {
      calls.push(args.join(" "));
      if (args[0] === "record") {
        showCount += 1;
        return { ok: true, data: { id: "T-STALE", kind: "task", status: showCount === 1 ? "todo" : "in_progress" } };
      }
      if (args[0] === "task" && args[1] === "update") {
        return { ok: false, error: { code: "invalid_transition", message: "todo -> in_progress is stale" } };
      }
      return { ok: true, data: { id: "T-STALE", kind: "task", status: "done" } };
    },
  });

  expect(result).toMatchObject({
    ok: true,
    data: { id: "T-STALE", status: "done" },
    project_ledger_transition_plan: {
      refreshes: 1,
      executed: [{ command: "task complete --id T-STALE" }],
    },
  });
  expect(calls).toEqual([
    `record show --project ${projectPath} --kind task --id T-STALE`,
    `task update --project ${projectPath} --id T-STALE --status in_progress`,
    `record show --project ${projectPath} --kind task --id T-STALE`,
    `task complete --project ${projectPath} --id T-STALE`,
  ]);
});

test("Project Ledger planner stops after one stale transition refresh", () => {
  const calls: string[] = [];
  const result = runProjectLedgerPlannedLifecycleMutation({
    executor,
    toolName: "project_ledger_task_complete",
    args: { id: "T-STALE", validation: "tested", review: "reviewed", report: "reports/t.md" },
    projectPath,
    finalCliArgs: ["task", "complete", "--project", projectPath, "--id", "T-STALE"],
    runTool: (_input, args) => {
      calls.push(args.join(" "));
      if (args[0] === "record") return { ok: true, data: { id: "T-STALE", kind: "task", status: "todo" } };
      return { ok: false, error: { code: "invalid_transition", message: "still stale" } };
    },
  });

  expect(result).toMatchObject({
    ok: false,
    recoverable: true,
    error: { code: "invalid_transition" },
    project_ledger_transition_plan: {
      refreshes: 1,
      executed: [{ command: "task update --id T-STALE --status in_progress" }],
    },
  });
  expect(calls).toEqual([
    `record show --project ${projectPath} --kind task --id T-STALE`,
    `task update --project ${projectPath} --id T-STALE --status in_progress`,
    `record show --project ${projectPath} --kind task --id T-STALE`,
    `task update --project ${projectPath} --id T-STALE --status in_progress`,
  ]);
});

test("Project Ledger planner treats matching completed records as stale replay no-op", () => {
  const calls: string[] = [];
  const result = runProjectLedgerPlannedLifecycleMutation({
    executor,
    toolName: "project_ledger_work_complete",
    args: { id: "W-DONE", validation: "tested", review: "reviewed", report: "reports/w.md" },
    projectPath,
    finalCliArgs: ["work", "complete", "--project", projectPath, "--id", "W-DONE"],
    runTool: (_input, args) => {
      calls.push(args.join(" "));
      return {
        ok: true,
        data: {
          id: "W-DONE",
          kind: "work",
          status: "done",
          validation: "tested",
          review: "reviewed",
          report: "reports/w.md",
        },
      };
    },
  });

  expect(result).toMatchObject({
    ok: true,
    data: { id: "W-DONE", status: "done" },
    project_ledger_transition_plan: {
      refreshes: 0,
      executed: [],
    },
  });
  expect(calls).toEqual([
    `record show --project ${projectPath} --kind work --id W-DONE`,
  ]);
});

test("Project Ledger planner rejects completed records with changed closeout evidence", () => {
  const result = runProjectLedgerPlannedLifecycleMutation({
    executor,
    toolName: "project_ledger_task_complete",
    args: { id: "T-DONE", validation: "new validation", review: "reviewed", report: "reports/t.md" },
    projectPath,
    finalCliArgs: ["task", "complete", "--project", projectPath, "--id", "T-DONE"],
    runTool: () => ({
      ok: true,
      data: {
        id: "T-DONE",
        kind: "task",
        status: "done",
        validation: "old validation",
        review: "reviewed",
        report: "reports/t.md",
      },
    }),
  });

  expect(result).toMatchObject({
    ok: false,
    recoverable: true,
    error: {
      code: "already_completed",
      native_next: [expect.objectContaining({ tool: "project_ledger_show", args: { id: "T-DONE" } })],
    },
    project_ledger_transition_plan: {
      refreshes: 0,
      executed: [],
    },
  });
});

test("Project Ledger planner rejects a completed Work replay with changed acceptance", () => {
  const result = runProjectLedgerPlannedLifecycleMutation({
    executor,
    toolName: "project_ledger_work_complete",
    args: {
      id: "W-DONE",
      acceptance: "new acceptance",
      validation: "tested",
      review: "reviewed",
      report: "reports/w.md",
    },
    projectPath,
    finalCliArgs: ["work", "complete", "--project", projectPath, "--id", "W-DONE"],
    runTool: () => ({
      ok: true,
      data: {
        id: "W-DONE",
        kind: "work",
        status: "done",
        acceptance: "original acceptance",
        validation: "tested",
        review: "reviewed",
        report: "reports/w.md",
      },
    }),
  });

  expect(result).toMatchObject({
    ok: false,
    recoverable: true,
    error: { code: "already_completed" },
  });
});

test("Project Ledger planner rejects completed work without matching evidence", () => {
  const result = runProjectLedgerPlannedLifecycleMutation({
    executor,
    toolName: "project_ledger_work_complete",
    args: { id: "W-DONE", validation: "tested", review: "reviewed" },
    projectPath,
    finalCliArgs: ["work", "complete", "--project", projectPath, "--id", "W-DONE"],
    runTool: () => ({
      ok: true,
      data: {
        id: "W-DONE",
        kind: "work",
        status: "done",
        validation: "tested",
        review: "reviewed",
        report: "reports/w.md",
      },
    }),
  });

  expect(result).toMatchObject({
    ok: false,
    recoverable: true,
    error: { code: "already_completed" },
  });
});

test("Project Ledger planner moves failed tasks back to in_progress before completion", () => {
  const calls: string[] = [];
  const result = runProjectLedgerPlannedLifecycleMutation({
    executor,
    toolName: "project_ledger_task_complete",
    args: { id: "T-FAILED", validation: "tested", review: "reviewed", report: "reports/t.md" },
    projectPath,
    finalCliArgs: ["task", "complete", "--project", projectPath, "--id", "T-FAILED"],
    runTool: (_input, args) => {
      calls.push(args.join(" "));
      if (args[0] === "record") return { ok: true, data: { id: "T-FAILED", kind: "task", status: "failed" } };
      if (args[0] === "task" && args[1] === "update") return { ok: true, data: { id: "T-FAILED", kind: "task", status: "in_progress" } };
      return { ok: true, data: { id: "T-FAILED", kind: "task", status: "done" } };
    },
  });

  expect(result).toMatchObject({
    ok: true,
    data: { id: "T-FAILED", status: "done" },
    project_ledger_transition_plan: {
      refreshes: 0,
      executed: [
        { command: "task update --id T-FAILED --status in_progress" },
        { command: "task complete --id T-FAILED" },
      ],
    },
  });
  expect(calls).toEqual([
    `record show --project ${projectPath} --kind task --id T-FAILED`,
    `task update --project ${projectPath} --id T-FAILED --status in_progress`,
    `task complete --project ${projectPath} --id T-FAILED`,
  ]);
});
