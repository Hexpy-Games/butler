import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { projectLedgerProjectPath } from "../../packages/butler-agent/src/integrations/project-ledger/client.ts";

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
}): void {
  const db = new Database(path);
  db.run(`
    CREATE TABLE projects (
      id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      workspace_label TEXT NOT NULL,
      safe_path_label TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `);
  db.query(`
    INSERT INTO projects (
      id, display_name, workspace_path, workspace_label, safe_path_label, archived, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `).run(
    input.id,
    input.displayName,
    input.workspacePath,
    input.workspaceLabel ?? input.displayName,
    input.safePathLabel ?? input.displayName,
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

  test("maps an active app project id through the app project registry before falling back to Butler", () => {
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
    });

    expect(projectLedgerProjectPath({
      butlerHome,
      butlerData,
      appMessageDbPath: appDbPath,
      projectId: "project-sandy-bot-35a0e102",
    }, {})).toBe(join(butlerData, "project-ledger", "projects", "sandy-bot"));
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
          appMessageDbPath: appDbPath,
          projectId: "project-sandy-bot-35a0e102",
        },
        {},
      );
    }).toThrow("project_ledger_project_resolution_failed");
  });

  test("maps an explicit app project name through the app project registry", () => {
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
    });

    expect(projectLedgerProjectPath({
      butlerHome,
      butlerData,
      appMessageDbPath: appDbPath,
    }, { project_path: "Sandy Bot" })).toBe(join(butlerData, "project-ledger", "projects", "sandy-bot"));
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
});
