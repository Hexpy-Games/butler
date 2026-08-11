import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { M1V2DbEvidence } from "./contracts.ts";

const MAX_DATABASES = 40;

export function readM1V2DbEvidence(
  butlerData: string,
  turnId: string,
): M1V2DbEvidence {
  const paths = sqlitePaths(butlerData);
  let quickCheckPassed = paths.length > 0;
  const toolNames: string[] = [];
  for (const path of paths) {
    let db: Database;
    try {
      db = new Database(path, { readonly: true });
    } catch {
      quickCheckPassed = false;
      continue;
    }
    try {
      const quick = db.query<{ quick_check: string }, []>("PRAGMA quick_check").get();
      quickCheckPassed &&= quick?.quick_check === "ok";
      if (!tableExists(db, "btcc_guided_tool_calls")) continue;
      toolNames.push(...db.query<{ tool_name: string }, [string]>(`
        SELECT tool_name FROM btcc_guided_tool_calls
        WHERE turn_id = ? ORDER BY started_at, call_id
      `).all(turnId).map((row) => row.tool_name));
    } catch {
      quickCheckPassed = false;
    } finally {
      db.close();
    }
  }
  return {
    quickCheckDatabases: paths.length,
    quickCheckPassed,
    toolCalls: toolNames.length,
    webToolCalls: toolNames.filter((name) =>
      name === "web_search" || name === "web_read").length,
    pagePreviewToolCalls: toolNames.filter((name) =>
      name === "inspect_workspace_page").length,
    buildCommandToolCalls: toolNames.filter((name) => name === "run_command").length,
    fileMutationToolCalls: toolNames.filter((name) =>
      name === "write_file" || name === "edit_file").length,
  };
}

function sqlitePaths(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const visit = (directory: string): void => {
    if (found.length >= MAX_DATABASES) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (found.length >= MAX_DATABASES) return;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith(".sqlite") || entry.name.endsWith(".db")) &&
        statSync(path).size > 0
      ) found.push(path);
    }
  };
  visit(root);
  return found.sort();
}

function tableExists(db: Database, table: string): boolean {
  return Boolean(db.query<{ name: string }, [string]>(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
  `).get(table));
}
