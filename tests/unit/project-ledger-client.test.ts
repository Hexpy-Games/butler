import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  ProjectLedgerProjectScopeError,
  projectLedgerProjectPath,
  runProjectLedgerTool,
} from "../../packages/butler-agent/src/integrations/project-ledger/client.ts";
import { createProjectLedgerToolHandlers } from
  "../../packages/butler-agent/src/agent/tools/project-ledger/shared.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "butler-project-ledger-client-"));
  tempDirs.push(dir);
  return dir;
}

function writeLedgerRoot(root: string, id: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "project.json"), `${JSON.stringify({ id, name: id })}\n`, "utf8");
  writeFileSync(join(root, "ledger.jsonl"), "", "utf8");
}

function writeAppProjectDb(path: string, input: {
  id: string;
  displayName: string;
  workspacePath: string;
  workspaceLabel?: string;
  safePathLabel?: string;
  ledgerProjectId?: string;
}): void {
  const db = new Database(path);
  db.run(`
    CREATE TABLE projects (
      id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      workspace_label TEXT NOT NULL,
      safe_path_label TEXT NOT NULL,
      ledger_project_id TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `);
  db.query(`
    INSERT INTO projects (
      id, display_name, workspace_path, workspace_label, safe_path_label,
      ledger_project_id, archived, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `).run(
    input.id,
    input.displayName,
    input.workspacePath,
    input.workspaceLabel ?? input.displayName,
    input.safePathLabel ?? input.displayName,
    input.ledgerProjectId ?? input.id,
    new Date().toISOString(),
  );
  db.close(false);
}

describe("projectLedgerProjectPath", () => {
  test("maps a workspace project path to the canonical BUTLER_DATA Project Ledger root", () => {
    const butlerHome = makeTempDir();
    const butlerData = makeTempDir();
    const workspace = join(makeTempDir(), "sandy-bot");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "package.json"), `${JSON.stringify({ name: "sandy-bot" })}\n`, "utf8");

    const ledgerRoot = join(butlerData, "project-ledger", "projects", "sandy-bot");
    writeLedgerRoot(ledgerRoot, "sandy-bot");

    expect(projectLedgerProjectPath({ butlerHome, butlerData }, { project_path: workspace })).toBe(ledgerRoot);
  });

  test("maps an uninitialized workspace project path to the canonical BUTLER_DATA Project Ledger root", () => {
    const butlerHome = makeTempDir();
    const butlerData = makeTempDir();
    const workspace = join(makeTempDir(), "sandy-bot");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "package.json"), `${JSON.stringify({ name: "sandy-bot" })}\n`, "utf8");

    expect(projectLedgerProjectPath({ butlerHome, butlerData }, { project_path: workspace })).toBe(
      join(butlerData, "project-ledger", "projects", "sandy-bot"),
    );
  });

  test("uses the active session workspace as the default project path", () => {
    const butlerHome = makeTempDir();
    const butlerData = makeTempDir();
    const workspace = join(makeTempDir(), "sandy-bot");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "package.json"), `${JSON.stringify({ name: "sandy-bot" })}\n`, "utf8");

    expect(projectLedgerProjectPath({ butlerHome, butlerData, workspacePath: workspace }, {})).toBe(
      join(butlerData, "project-ledger", "projects", "sandy-bot"),
    );
  });

  test("maps bounded App project and workspace facts without opening the App registry", () => {
    const butlerHome = makeTempDir();
    const butlerData = makeTempDir();
    const workspace = join(makeTempDir(), "sandy-workspace-folder");
    const appDbPath = join(makeTempDir(), "butler-client.sqlite");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "package.json"), `${JSON.stringify({ name: "sandy-bot" })}\n`, "utf8");
    writeAppProjectDb(appDbPath, {
      id: "project-sandy-bot-35a0e102",
      displayName: "Sandy Bot",
      workspacePath: workspace,
      ledgerProjectId: "sandy-bot",
    });

    expect(projectLedgerProjectPath({
      butlerHome,
      butlerData,
      projectId: "project-sandy-bot-35a0e102",
      workspacePath: workspace,
    }, {})).toBe(join(
      butlerData,
      "project-ledger",
      "projects",
      "sandy-bot",
    ));
  });

  test("pins explicit references to the bounded active project context", () => {
    const butlerHome = makeTempDir();
    const butlerData = makeTempDir();
    const workspace = join(makeTempDir(), "sandy-workspace-folder");
    const appDbPath = join(makeTempDir(), "butler-client.sqlite");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "package.json"), `${JSON.stringify({ name: "sandy-bot" })}\n`, "utf8");
    writeAppProjectDb(appDbPath, {
      id: "project-sandy-bot-35a0e102",
      displayName: "Sandy Bot",
      workspacePath: workspace,
      ledgerProjectId: "sandy-bot",
    });
    const input = {
      butlerHome,
      butlerData,
      projectId: "project-sandy-bot-35a0e102",
      workspacePath: workspace,
    };

    expect(projectLedgerProjectPath(input, {
      project_ref: "project-sandy-bot-35a0e102",
    })).toBe(join(
      butlerData,
      "project-ledger",
      "projects",
      "sandy-bot",
    ));
    for (const args of [
      { project_ref: "other-project" },
      { project_path: workspace },
      {
        project_ref: "project-sandy-bot-35a0e102",
        project_path: "other-project",
      },
    ]) {
      expect(() => projectLedgerProjectPath(input, args))
        .toThrow(ProjectLedgerProjectScopeError);
    }
  });

  test("does not turn an unmapped app project id into a Butler default", () => {
    const butlerHome = makeTempDir();
    const butlerData = makeTempDir();
    const appDbPath = join(makeTempDir(), "butler-client.sqlite");
    writeAppProjectDb(appDbPath, {
      id: "project-other",
      displayName: "Other",
      workspacePath: join(makeTempDir(), "other"),
    });

    expect(() => {
      projectLedgerProjectPath(
        {
          butlerHome,
          butlerData,
          projectId: "project-sandy-bot-35a0e102",
        },
        {},
      );
    }).toThrow("project_ledger_project_resolution_failed");
  });

  test("maps an explicit workspace path without opening the App project registry", () => {
    const butlerHome = makeTempDir();
    const butlerData = makeTempDir();
    const workspace = join(makeTempDir(), "sandy-workspace-folder");
    const appDbPath = join(makeTempDir(), "butler-client.sqlite");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "package.json"), `${JSON.stringify({ name: "sandy-bot" })}\n`, "utf8");
    writeAppProjectDb(appDbPath, {
      id: "project-sandy-bot-35a0e102",
      displayName: "Sandy Bot",
      workspacePath: workspace,
      ledgerProjectId: "sandy-bot",
    });

    expect(projectLedgerProjectPath({
      butlerHome,
      butlerData,
    }, { project_path: workspace })).toBe(join(
      butlerData,
      "project-ledger",
      "projects",
      "sandy-bot",
    ));
  });

  test("falls back to the Butler repository only when no session workspace is available", () => {
    const butlerHome = join(makeTempDir(), "butler");
    const butlerData = makeTempDir();
    mkdirSync(butlerHome, { recursive: true });

    expect(projectLedgerProjectPath({ butlerHome, butlerData }, {})).toBe(
      join(butlerData, "project-ledger", "projects", "butler"),
    );
  });

  test("ignores a repo-local .project-ledger root when resolving a workspace project path", () => {
    const butlerHome = makeTempDir();
    const butlerData = makeTempDir();
    const workspace = join(makeTempDir(), "sandy-bot");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "package.json"), `${JSON.stringify({ name: "sandy-bot" })}\n`, "utf8");
    writeLedgerRoot(join(workspace, ".project-ledger"), "repo-local-sandy");

    expect(projectLedgerProjectPath({ butlerHome, butlerData }, { project_path: workspace })).toBe(
      join(butlerData, "project-ledger", "projects", "sandy-bot"),
    );
  });

  test("keeps a direct BUTLER_DATA Project Ledger root unchanged", () => {
    const butlerHome = makeTempDir();
    const butlerData = makeTempDir();
    const ledgerRoot = join(butlerData, "project-ledger", "projects", "butler");
    writeLedgerRoot(ledgerRoot, "butler");

    expect(projectLedgerProjectPath({ butlerHome, butlerData }, { project_path: ledgerRoot })).toBe(ledgerRoot);
  });

  test("treats fresh status and query as normal empty reads", async () => {
    const butlerHome = process.cwd();
    const butlerData = makeTempDir();
    const projectPath = join(makeTempDir(), "fresh-project");
    const clientInput = { butlerHome, butlerData };

    expect(runProjectLedgerTool(clientInput, [
      "status",
      "--project",
      projectPath,
    ])).toMatchObject({
      ok: true,
      data: { initialized: false },
      error: null,
    });
    expect(runProjectLedgerTool(clientInput, [
      "query",
      "--project",
      projectPath,
      "--kind",
      "work",
    ])).toMatchObject({
      ok: true,
      data: {
        initialized: false,
        kind: "work",
        results: [],
      },
      error: null,
    });
    expect(runProjectLedgerTool(clientInput, [
      "query",
      "--project",
      projectPath,
      "--kind",
      "works",
    ])).toMatchObject({
      ok: false,
      error: { code: "invalid_query_kind" },
    });
    expect(existsSync(projectPath)).toBe(false);

    expect(runProjectLedgerTool(clientInput, [
      "record",
      "show",
      "--project",
      projectPath,
      "--id",
      "W-MISSING",
    ])).toMatchObject({
      ok: false,
      error: { code: "record_not_found" },
    });

    const publicStatus = await createProjectLedgerToolHandlers({
      butlerHome,
      butlerData: "",
    }).inspect_project_status({ args: { project_path: projectPath } });
    expect(publicStatus).toMatchObject({
      ok: true,
      data: { initialized: false },
    });
    expect(publicStatus).not.toHaveProperty("evidence_capability_receipts");
  });
});
