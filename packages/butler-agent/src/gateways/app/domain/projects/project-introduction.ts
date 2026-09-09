import type { Database } from "bun:sqlite";

/** Only initialize an untouched description. An explicit empty user edit stays empty. */
export function initializeProjectIntroduction(db: Database, projectId: string, revision: number, description: string): boolean {
  return db.query(`UPDATE projects SET description = ?, dashboard_preferences_revision = dashboard_preferences_revision + 1
    WHERE id = ? AND description IS NULL AND dashboard_preferences_revision = ?`)
    .run(description, projectId, revision).changes === 1;
}
