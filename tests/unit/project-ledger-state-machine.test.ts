import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { spawnSync } from "child_process";

const root = process.cwd();
const cliPath = join(root, "packages", "project-ledger", "bin", "project-ledger");
const stateMachineUrl = pathToFileURL(
  join(root, "packages", "project-ledger", "src", "state-machine.js"),
).href;

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "project-ledger-state-"));
}

function runLedgerJson(args: string[]): any {
  const result = spawnSync(process.execPath, [cliPath, ...args, "--json"], {
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stderr: result.stderr,
    json: result.stdout ? JSON.parse(result.stdout) : null,
  };
}

test("state-machine module rejects invalid transitions and validates completion evidence", async () => {
  const { assertTransition, completionGateIssues } = await import(stateMachineUrl) as any;

  expect(() => assertTransition("work", "proposed", "done")).toThrow("Invalid work transition");
  expect(() => assertTransition("work", "review", "done")).not.toThrow();
  expect(completionGateIssues({
    kind: "work",
    status: "done",
    spec: null,
    acceptance: "ok",
    validation: null,
    review: "reviewed",
    report: "report.md",
  }).map((issue: any) => issue.field)).toEqual(["spec", "validation"]);
  expect(completionGateIssues({
    kind: "work",
    status: "done",
    spec: "docs/specs/project-ledger.md",
    acceptance: "ok",
    validation: "tested",
    review: "reviewed",
    report: "report.md",
    requiresCommitEvidence: true,
    codeCommits: null,
  }).map((issue: any) => issue.field)).toEqual(["codeCommits"]);
  expect(completionGateIssues({
    kind: "work",
    status: "done",
    spec: "docs/specs/project-ledger.md",
    acceptance: "ok",
    validation: "tested",
    review: "reviewed",
    report: "report.md",
    requiresCommitEvidence: true,
    codeCommits: JSON.stringify([{ repo: "butler", hash: "abc123", message: "Test commit evidence" }]),
  })).toEqual([]);
});

test("work task and attempt commands enforce state transitions and completion gate", () => {
  const project = tempProject();
  try {
    expect(runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo"]).status).toBe(0);
    expect(runLedgerJson([
      "work",
      "create",
      "--project",
      project,
      "--id",
      "W-STATE",
      "--title",
      "State machine test",
      "--spec",
      "docs/specs/project-ledger.md",
      "--acceptance",
      "State transitions are enforced",
    ]).status).toBe(0);

    const invalidComplete = runLedgerJson(["work", "complete", "--project", project, "--id", "W-STATE"]);
    expect(invalidComplete.status).toBe(2);
    expect(invalidComplete.json.error.code).toBe("invalid_transition");

    for (const status of ["scoped", "specified", "in_progress", "review"]) {
      expect(runLedgerJson(["work", "update", "--project", project, "--id", "W-STATE", "--status", status]).status)
        .toBe(0);
    }

    const missingEvidence = runLedgerJson(["work", "complete", "--project", project, "--id", "W-STATE"]);
    expect(missingEvidence.status).toBe(1);
    expect(missingEvidence.json.error.code).toBe("completion_gate_failed");

    expect(runLedgerJson([
      "work",
      "complete",
      "--project",
      project,
      "--id",
      "W-STATE",
      "--validation",
      "bun test",
      "--review",
      "external peer review",
      "--report",
      "docs/reports/state.md",
    ]).status).toBe(0);

    const duplicateComplete = runLedgerJson([
      "work",
      "complete",
      "--project",
      project,
      "--id",
      "W-STATE",
      "--validation",
      "bun test",
      "--review",
      "external peer review",
      "--report",
      "docs/reports/state.md",
    ]);
    expect(duplicateComplete.status).toBe(2);
    expect(duplicateComplete.json.error.code).toBe("invalid_transition");

    expect(runLedgerJson([
      "task",
      "create",
      "--project",
      project,
      "--work",
      "W-STATE",
      "--id",
      "T-STATE",
      "--title",
      "Task state",
    ]).status).toBe(0);
    expect(runLedgerJson(["task", "update", "--project", project, "--id", "T-STATE", "--status", "in_progress"]).status)
      .toBe(0);
    expect(runLedgerJson(["attempt", "start", "--project", project, "--task", "T-STATE", "--id", "A-STATE"]).status)
      .toBe(0);
    expect(runLedgerJson(["attempt", "succeed", "--project", project, "--id", "A-STATE"]).status).toBe(0);
    expect(runLedgerJson(["task", "complete", "--project", project, "--id", "T-STATE"]).status).toBe(0);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
