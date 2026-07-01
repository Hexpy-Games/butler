import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import type { SettingRow } from "../../infrastructure/core/records.ts";

export const DEFAULT_PROJECT_WORKSPACE_SETTING_KEY =
  "default-project-workspace-root";

export class AppSettingsPersistence {
  constructor(private readonly db: Database) {}

  read<T>(key: string): T | null {
    const row = this.db
      .query<
        SettingRow,
        [string]
      >("SELECT key, value_json FROM app_settings WHERE key = ?")
      .get(key);
    if (!row) return null;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return null;
    }
  }

  readStoredProjectWorkspaceRoot(): string | null {
    const stored = this.read<string>(DEFAULT_PROJECT_WORKSPACE_SETTING_KEY);
    if (typeof stored !== "string" || !stored.trim()) return null;
    return resolve(stored);
  }

  write(key: string, value: unknown): void {
    this.db
      .query(
        `
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `,
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
  }
}
