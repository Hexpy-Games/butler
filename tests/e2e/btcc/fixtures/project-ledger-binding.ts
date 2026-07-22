import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { ActiveProjectLedgerResolver } from "../../../../packages/butler-agent/src/integrations/project-ledger/active-project-ledger-reference.ts";
import type { ScenarioFixture } from "../contracts.ts";

export function seedAppProjectBinding(input: {
  dbPath: string;
  fixture: ScenarioFixture;
}): void {
  if (!input.fixture.projectRef) return;
  mkdirSync(dirname(input.dbPath), { recursive: true });
  const db = new Database(input.dbPath, { create: true });
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        display_name TEXT,
        workspace_path TEXT,
        workspace_label TEXT,
        safe_path_label TEXT,
        updated_at TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.query(`
      INSERT INTO projects (
        id, display_name, workspace_path, workspace_label,
        safe_path_label, updated_at, archived
      ) VALUES (?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET
        workspace_path = excluded.workspace_path,
        updated_at = excluded.updated_at,
        archived = 0
    `).run(
      input.fixture.projectRef,
      input.fixture.projectRef,
      input.fixture.workspacePath,
      input.fixture.projectRef,
      input.fixture.projectRef,
      "2026-01-01T00:00:00.000Z",
    );
  } finally {
    db.close();
  }
}

export function resolveFixtureProjectLedger(input: {
  dbPath: string;
  fixture: ScenarioFixture;
}): { initialized: boolean; ledgerRoot: string } | null {
  if (!input.fixture.projectRef) return null;
  const reference = new ActiveProjectLedgerResolver().resolve({
    butlerData: input.fixture.butlerData,
    appMessageDbPath: input.dbPath,
    appProjectId: input.fixture.projectRef,
    workspacePath: input.fixture.workspacePath,
  });
  return { initialized: reference.initialized, ledgerRoot: reference.ledger_root };
}
