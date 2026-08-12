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

/**
 * Configure a non-authoritative reader for a database whose schema and writes
 * are owned by another process. This intentionally never changes journal mode
 * or runs migrations, so opening the reader cannot contend for a writer lock.
 */
export function coordinateSharedSqliteReader(db: Database): void {
  db.exec(`PRAGMA busy_timeout=${WRITER_HANDOFF_WINDOW_MS}`);
  db.exec("PRAGMA query_only=ON");
  db.exec("PRAGMA foreign_keys=ON");
}
