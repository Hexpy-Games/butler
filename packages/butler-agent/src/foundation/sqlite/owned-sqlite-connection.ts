import { Database, type DatabaseOptions } from "bun:sqlite";

export type OwnedSqliteConnection = {
  database: Database;
  close(): void;
  statementCacheSize(): number;
};

export function openOwnedSqliteConnection(
  path: string,
  options?: DatabaseOptions,
): OwnedSqliteConnection {
  const database = new Database(path, options);

  let closed = false;
  return {
    database,
    close() {
      if (closed) return;
      closed = true;
      // Let Bun drain its own statement cache. Forcing close(true) while a
      // native iterator is still active can surface `database is locked`;
      // this wrapper does not own those statement lifetimes.
      database.close(false);
    },
    statementCacheSize() {
      // Statement objects belong to Bun's Database implementation. We must
      // not retain, share, or finalize them here: a caller may still be
      // iterating while another projection/retention operation prepares the
      // same SQL, and finalizing a shared object can raise native RangeError.
      return 0;
    },
  };
}
