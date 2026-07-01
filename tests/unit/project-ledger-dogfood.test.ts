import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { basename, join } from "path";
import { spawnSync } from "child_process";

const root = process.cwd();
const cliPath = join(root, "packages", "project-ledger", "bin", "project-ledger");
const butlerData = join(homedir(), ".butler");
const butlerLedgerRoot = join(butlerData, "project-ledger", "projects", "butler");

function runLedgerJson(args: string[]): any {
  const result = spawnSync(process.execPath, [cliPath, ...args, "--project", root, "--json"], {
    encoding: "utf8",
    env: { ...process.env, BUTLER_DATA: butlerData },
    maxBuffer: 20 * 1024 * 1024,
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "project-ledger-sandy-dogfood-"));
}

function testButlerData(project: string): string {
  return join(project, ".butler-data");
}

function tempLedgerRoot(project: string): string {
  return join(testButlerData(project), "project-ledger", "projects", basename(project));
}

function runTempLedgerJson(project: string, args: string[], input?: string): any {
  const result = spawnSync(process.execPath, [cliPath, ...args, "--project", project, "--json"], {
    encoding: "utf8",
    env: { ...process.env, BUTLER_DATA: testButlerData(project) },
    input,
    maxBuffer: 20 * 1024 * 1024,
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

test("Butler repo dogfoods Project Ledger with generated bounded views", () => {
  runLedgerJson(["index"]);
  runLedgerJson(["render", "dashboard", "--write"]);
  runLedgerJson(["render", "handoff", "--write"]);
  runLedgerJson(["render", "roadmap", "--write"]);
  runLedgerJson(["index"]);

  expect(existsSync(join(butlerLedgerRoot, "project.json"))).toBe(true);
  expect(existsSync(join(butlerLedgerRoot, "views", "dashboard.md"))).toBe(true);
  expect(existsSync(join(butlerLedgerRoot, "views", "handoff.md"))).toBe(true);
  expect(existsSync(join(butlerLedgerRoot, "views", "roadmap.md"))).toBe(true);

  const status = runLedgerJson(["status"]);
  expect(status.data.project.id).toBe("butler");
  expect(status.data.counts.work).toBeGreaterThanOrEqual(6);
  expect(status.data.index.stale).toBe(false);
  expect(status.data.staleViews).toEqual([]);

  const check = runLedgerJson(["check"]);
  expect(check.ok).toBe(true);
  expect(check.data.issueCount).toBe(0);
});

test("Sandy-shaped closeout uses valid CLI lifecycle transitions and sequential render/check", () => {
  const project = tempProject();
  try {
    runTempLedgerJson(project, [
      "init",
      "--id",
      "sandy-dogfood",
      "--name",
      "Sandy Dogfood",
    ]);

    const statusBefore = runTempLedgerJson(project, ["status"]);
    expect(statusBefore.data.project.id).toBe("sandy-dogfood");
    const nextActionsBefore = runTempLedgerJson(project, ["query", "--kind", "next-actions"]);
    expect(nextActionsBefore.data.results).toEqual([]);

    runTempLedgerJson(project, [
      "record",
      "create",
      "--kind",
      "spec",
      "--id",
      "SPEC-SANDY-CLOSEOUT",
      "--title",
      "Sandy closeout contract",
      "--from",
      "-",
    ], "# Sandy closeout contract\n\nUse CLI lifecycle commands for closeout.\n");

    const work = runTempLedgerJson(project, [
      "work",
      "create",
      "--id",
      "W-SANDY-CLOSEOUT",
      "--title",
      "Sandy closeout workflow",
      "--spec",
      "SPEC-SANDY-CLOSEOUT",
      "--acceptance",
      "Sandy can close work with validation, review, and report evidence",
    ]);
    expect(work.data.status).toBe("proposed");

    const task = runTempLedgerJson(project, [
      "task",
      "create",
      "--work",
      "W-SANDY-CLOSEOUT",
      "--id",
      "T-SANDY-CLOSEOUT",
      "--title",
      "Run Sandy closeout",
      "--validation",
      "Sandy-shaped task validation is recorded",
    ]);
    expect(task.data.status).toBe("todo");

    runTempLedgerJson(project, ["index"]);
    const selected = runTempLedgerJson(project, ["query", "--kind", "next-actions"]);
    expect(selected.data.results.map((item: any) => item.id)).toContain("W-SANDY-CLOSEOUT");

    const attempt = runTempLedgerJson(project, [
      "attempt",
      "start",
      "--task",
      "T-SANDY-CLOSEOUT",
      "--id",
      "A-SANDY-CLOSEOUT",
      "--report",
      "reports/sandy-closeout.md",
    ]);
    expect(attempt.data.status).toBe("started");

    const taskInProgress = runTempLedgerJson(project, [
      "task",
      "update",
      "--id",
      "T-SANDY-CLOSEOUT",
      "--status",
      "in_progress",
    ]);
    expect(taskInProgress.data.status).toBe("in_progress");

    runTempLedgerJson(project, ["index"]);
    const succeeded = runTempLedgerJson(project, [
      "attempt",
      "succeed",
      "--id",
      "A-SANDY-CLOSEOUT",
      "--validation",
      "Sandy closeout attempt passed",
      "--review",
      "Attempt evidence is complete",
      "--report",
      "reports/sandy-closeout.md",
    ]);
    expect(succeeded.data.status).toBe("succeeded");

    const taskDone = runTempLedgerJson(project, [
      "task",
      "complete",
      "--id",
      "T-SANDY-CLOSEOUT",
      "--validation",
      "Sandy task lifecycle passed",
      "--review",
      "Task review passed",
      "--report",
      "reports/sandy-closeout.md",
    ]);
    expect(taskDone.data.status).toBe("done");

    for (const status of ["scoped", "specified", "in_progress", "review"]) {
      const updated = runTempLedgerJson(project, [
        "work",
        "update",
        "--id",
        "W-SANDY-CLOSEOUT",
        "--status",
        status,
      ]);
      expect(updated.data.status).toBe(status);
    }

    const completed = runTempLedgerJson(project, [
      "work",
      "complete",
      "--id",
      "W-SANDY-CLOSEOUT",
      "--validation",
      "Sandy closeout dogfood passed valid lifecycle commands",
      "--review",
      "Internal review found required evidence present",
      "--report",
      "reports/sandy-closeout.md",
    ]);
    expect(completed.data.status).toBe("done");

    runTempLedgerJson(project, [
      "record",
      "create",
      "--kind",
      "report",
      "--id",
      "REPORT-SANDY-CLOSEOUT",
      "--title",
      "Sandy closeout report",
      "--from",
      "-",
    ], "# Sandy closeout report\n\nLifecycle, evidence, render, status, and check passed.\n");

    runTempLedgerJson(project, ["index"]);
    runTempLedgerJson(project, ["render", "dashboard", "--write"]);
    runTempLedgerJson(project, ["render", "handoff", "--write"]);
    runTempLedgerJson(project, ["render", "roadmap", "--write"]);

    const statusAfter = runTempLedgerJson(project, ["status"]);
    expect(statusAfter.data.counts.work).toBe(1);
    expect(statusAfter.data.index.stale).toBe(false);
    expect(statusAfter.data.staleViews).toEqual([]);

    const check = runTempLedgerJson(project, ["check"]);
    expect(check.ok).toBe(true);
    expect(check.data.issueCount).toBe(0);
    expect(existsSync(join(tempLedgerRoot(project), "views", "dashboard.md"))).toBe(true);
    expect(existsSync(join(tempLedgerRoot(project), "views", "handoff.md"))).toBe(true);
    expect(existsSync(join(tempLedgerRoot(project), "views", "roadmap.md"))).toBe(true);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
