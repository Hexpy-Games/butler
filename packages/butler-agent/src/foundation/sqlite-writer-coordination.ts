import type { Database } from "bun:sqlite";

const WRITER_HANDOFF_WINDOW_MS = 5_000;

export type SqliteStorageProfile = "durable" | "ephemeral";

export function coordinateSharedSqliteWriter(
  db: Database,
  storageProfile: SqliteStorageProfile = "durable",
): void {
  db.exec(`PRAGMA busy_timeout=${WRITER_HANDOFF_WINDOW_MS}`);
  db.exec(`PRAGMA journal_mode=${storageProfile === "durable" ? "WAL" : "DELETE"}`);
  db.exec("PRAGMA foreign_keys=ON");
}
