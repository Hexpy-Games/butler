import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createButlerToolExecutor,
} from "../../packages/butler-agent/src/agent/tools/butler-tools.ts";
import {
  projectLedgerNativeToolDefinition,
} from "../../packages/butler-agent/src/agent/tools/project-ledger/native.ts";

const repositoryRoot = process.cwd();
const projectLedgerCli = join(
  repositoryRoot,
  "packages",
  "project-ledger",
  "bin",
  "project-ledger",
);
let fixtureRoot = "";
let projectPath = "";

beforeEach(() => {
  fixtureRoot = join(
    tmpdir(),
    `project-ledger-acceptance-${Date.now()}-${Math.random()}`,
  );
  projectPath = join(fixtureRoot, "project-ledger", "projects", "fixture");
  mkdirSync(projectPath, { recursive: true });
  runProjectLedger(["init", "--id", "fixture", "--name", "Fixture"]);
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

test("Project Ledger tools declare string-or-array acceptance without requiring it at completion", () => {
  const create = projectLedgerNativeToolDefinition("project_ledger_create");
  const complete = projectLedgerNativeToolDefinition(
    "project_ledger_work_complete",
  );
  const createProperties = create.parameters.properties as Record<
    string,
    Record<string, unknown>
  >;
  const completeProperties = complete.parameters.properties as Record<
    string,
    Record<string, unknown>
  >;
  const acceptance = createProperties.acceptance;

  expect(acceptance).toMatchObject({
    type: ["string", "array"],
    minItems: 1,
    items: { type: "string" },
  });
  expect(completeProperties.acceptance).toEqual(acceptance);
  expect(complete.parameters.required).not.toContain("acceptance");
});

test("native Project Ledger creation preserves acceptance arrays through completion", async () => {
  const execute = createExecutor();
  await createSpec(execute);

  const created = await execute({
    name: "project_ledger_create",
    args: {
      project_path: projectPath,
      kind: "work",
      id: "W-ACCEPTANCE-ARRAY",
      title: "Acceptance array work",
      status: "in_progress",
      spec: "SPEC-ACCEPTANCE",
      acceptance: [
        "The requested output is delivered",
        "   ",
        "The requested output is validated",
      ],
    },
    rawArguments: "{}",
  }) as Record<string, any>;

  expect(created).toMatchObject({
    ok: true,
    data: {
      id: "W-ACCEPTANCE-ARRAY",
      acceptance: "The requested output is delivered\nThe requested output is validated",
    },
  });

  const completed = await execute({
    name: "project_ledger_work_complete",
    args: {
      project_path: projectPath,
      id: "W-ACCEPTANCE-ARRAY",
      validation: "Focused validation passed",
      review: "The requested result was reviewed",
      report: "Delivered to the user",
    },
    rawArguments: "{}",
  }) as Record<string, any>;

  expect(completed).toMatchObject({
    ok: true,
    data: {
      id: "W-ACCEPTANCE-ARRAY",
      status: "done",
      acceptance: "The requested output is delivered\nThe requested output is validated",
    },
  });
});

test("native Work completion can restore acceptance omitted during creation", async () => {
  const execute = createExecutor();
  await createSpec(execute);

  const created = await execute({
    name: "project_ledger_create",
    args: {
      project_path: projectPath,
      kind: "work",
      id: "W-ACCEPTANCE-RECOVERY",
      title: "Acceptance recovery work",
      status: "in_progress",
      spec: "SPEC-ACCEPTANCE",
    },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(created).toMatchObject({
    ok: true,
    data: {
      id: "W-ACCEPTANCE-RECOVERY",
      acceptance: null,
    },
  });

  const missing = await execute({
    name: "project_ledger_work_complete",
    args: {
      project_path: projectPath,
      id: "W-ACCEPTANCE-RECOVERY",
      validation: "Focused validation passed",
      review: "The requested result was reviewed",
      report: "Delivered to the user",
    },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(missing).toMatchObject({
    ok: false,
    recoverable: true,
    error: { code: "completion_gate_failed" },
  });
  expect(JSON.stringify(missing.error)).toContain("missing_acceptance");

  const recovered = await execute({
    name: "project_ledger_work_complete",
    args: {
      project_path: projectPath,
      id: "W-ACCEPTANCE-RECOVERY",
      acceptance: [
        "The omitted acceptance is restored",
        "The recovered Work can be completed",
      ],
      validation: "Focused validation passed",
      review: "The requested result was reviewed",
      report: "Delivered to the user",
    },
    rawArguments: "{}",
  }) as Record<string, any>;

  expect(recovered).toMatchObject({
    ok: true,
    data: {
      id: "W-ACCEPTANCE-RECOVERY",
      status: "done",
      acceptance: "The omitted acceptance is restored\nThe recovered Work can be completed",
    },
  });
});

function createExecutor() {
  return createButlerToolExecutor({
    butlerHome: repositoryRoot,
    butlerData: fixtureRoot,
  });
}

async function createSpec(
  execute: ReturnType<typeof createButlerToolExecutor>,
): Promise<void> {
  const result = await execute({
    name: "project_ledger_create",
    args: {
      project_path: projectPath,
      kind: "spec",
      id: "SPEC-ACCEPTANCE",
      title: "Acceptance contract",
    },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(result.ok).toBe(true);
}

function runProjectLedger(args: string[]): void {
  const result = spawnSync(
    process.execPath,
    [projectLedgerCli, ...args, "--project", projectPath, "--json"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, BUTLER_DATA: fixtureRoot },
    },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
}
