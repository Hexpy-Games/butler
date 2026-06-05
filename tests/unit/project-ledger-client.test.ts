import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
