import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export function readDeveloperDiagnosticsEnabled(input: {
  dbPath?: string | null;
}): boolean {
  if (!input.dbPath || !existsSync(input.dbPath)) return false;
  let db: Database | null = null;
  try {
    db = new Database(input.dbPath, { readonly: true });
    const row = db
      .query<{ value_json: string }, [string]>(
        "SELECT value_json FROM app_settings WHERE key = ?",
      )
      .get("settings");
    if (!row) return false;
    const settings = JSON.parse(row.value_json) as {
      diagnostics_enabled?: unknown;
    };
    return settings?.diagnostics_enabled === true;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}
