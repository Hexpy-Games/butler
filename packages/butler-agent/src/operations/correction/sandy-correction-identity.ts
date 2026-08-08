import { existsSync, realpathSync, statSync, readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import {
  sha256,
  stableJson,
  type SandyDatabaseIdentity,
  type SandyFileIdentity,
} from "./sandy-correction-contracts.ts";

export function readDatabaseIdentity(path: string, db?: Database): SandyDatabaseIdentity {
  const canonicalPath = realpathSync(path);
  const stat = statSync(canonicalPath);
  const ownedDb = db ?? new Database(canonicalPath, { readonly: true });
  try {
    // The shared-memory file is SQLite's volatile WAL coordination cache. It
    // may be created, rewritten, or have its mtime touched by a read-only
    // open/backup without changing durable database semantics. Keep it in the
    // returned file inventory for recovery metadata, but exclude it from the
    // semantic database identity used by freshness gates.
    const identityWithoutHash = {
      canonicalPath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      pageCount: Number(pragmaValue(ownedDb, "page_count")),
      pageSize: Number(pragmaValue(ownedDb, "page_size")),
      schemaVersion: Number(pragmaValue(ownedDb, "schema_version")),
      userVersion: Number(pragmaValue(ownedDb, "user_version")),
      journalMode: String(pragmaValue(ownedDb, "journal_mode")),
      wal: readFileIdentity(`${canonicalPath}-wal`),
    };
    return {
      ...identityWithoutHash,
      shm: readFileIdentity(`${canonicalPath}-shm`),
      sha256: sha256(stableJson(identityWithoutHash)),
    };
  } finally {
    if (!db) ownedDb.close();
  }
}

export function readFileIdentity(path: string, hash = false): SandyFileIdentity {
  if (!existsSync(path)) return { path, exists: false, size: 0, mtimeMs: 0 };
  const stat = statSync(path);
  return {
    path,
    exists: true,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ...(hash ? { sha256: sha256(readFileSync(path)) } : {}),
  };
}

/** SQLite may touch the shared-memory file when BEGIN IMMEDIATE acquires a
 * writer lock. Compare durable identity fields separately from those volatile
 * mtime stamps while still checking row/result digests inside the transaction.
 */
export function sameStableDatabaseIdentity(
  left: SandyDatabaseIdentity,
  right: SandyDatabaseIdentity,
): boolean {
  return left.canonicalPath === right.canonicalPath && left.size === right.size &&
    left.pageCount === right.pageCount && left.pageSize === right.pageSize &&
    left.schemaVersion === right.schemaVersion && left.userVersion === right.userVersion &&
    left.journalMode === right.journalMode && sameFileFamily(left.wal, right.wal);
}

function sameFileFamily(left: SandyFileIdentity, right: SandyFileIdentity): boolean {
  return left.path === right.path && left.exists === right.exists && left.size === right.size &&
    (left.sha256 ?? null) === (right.sha256 ?? null);
}

function pragmaValue(db: Database, name: string): string | number {
  const row = db.query<Record<string, string | number>, []>(`PRAGMA ${name}`).get();
  return row ? Object.values(row)[0] ?? "" : "";
}
