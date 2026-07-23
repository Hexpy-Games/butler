import type { Database } from "bun:sqlite";

const WRITER_HANDOFF_WINDOW_MS = 5_000;

export function coordinateSharedSqliteWriter(db: Database): void {
  db.exec(`PRAGMA busy_timeout=${WRITER_HANDOFF_WINDOW_MS}`);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
}
