import { createHash, randomUUID } from "crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { Database } from "bun:sqlite";

export const MUTATION_LOCK_SHARD_COUNT = 64;
export const PRODUCTION_LOCK_BUSY_TIMEOUT_MS = 0;
export const MUTATION_LOCK_SHARD_DIRECTORY = "mutation-lock-shards";

interface FenceRow { generation: number }
interface OwnershipRow { ownership_token: string }

export interface DurableLockLease {
  readonly lockPath: string;
  readonly ownershipToken: string;
  readonly fencingGeneration: number;
  isOwned(): boolean;
  renew(now?: Date): boolean;
}

export function withSqliteMutationLock<T>(input: {
  lockPath: string;
  lockRoot?: string;
  ownerId: string;
  now?: Date;
  busyTimeoutMs?: number;
  action: (lease: DurableLockLease) => T;
}): T | null {
  const logicalKey = resolve(input.lockPath);
  const lockRoot = resolve(input.lockRoot ?? dirname(logicalKey));
  if (input.lockRoot) assertContained(lockRoot, logicalKey);
  const shardPath = sqliteMutationLockPath(logicalKey, input.lockRoot);
  prepareShardDirectory(dirname(shardPath), lockRoot);
  cleanupLegacyArtifacts(logicalKey, shardPath, lockRoot);
  if (existsSync(shardPath) && lstatSync(shardPath).isSymbolicLink()) {
    throw new Error("sqlite_mutation_lock_shard_symlink");
  }
  const db = new Database(shardPath, { create: true, strict: true });
  let transactionActive = false;
  try {
    chmodSync(shardPath, 0o600);
    assertContained(realpathSync(lockRoot), realpathSync(shardPath));
    try {
      configureDatabase(db, input.busyTimeoutMs);
      db.exec("BEGIN IMMEDIATE");
      transactionActive = true;
    } catch (error) {
      if (sqliteBusy(error)) return null;
      throw error;
    }
    const now = (input.now ?? new Date()).toISOString();
    const ownershipToken = randomUUID();
    db.query("UPDATE shard_fence SET generation = generation + 1 WHERE singleton = 1").run();
    const fence = db.query<FenceRow, []>("SELECT generation FROM shard_fence WHERE singleton = 1").get();
    if (!fence) throw new Error("sqlite_mutation_lock_fence_missing");
    db.query(`
      INSERT INTO active_lock(lock_key, ownership_token, owner_id, acquired_at, renewed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(lock_key) DO UPDATE SET
        ownership_token = excluded.ownership_token,
        owner_id = excluded.owner_id,
        acquired_at = excluded.acquired_at,
        renewed_at = excluded.renewed_at
    `).run(logicalKey, ownershipToken, input.ownerId, now, now);
    const lease: DurableLockLease = {
      lockPath: logicalKey,
      ownershipToken,
      fencingGeneration: fence.generation,
      isOwned: () => transactionActive && readOwnership(db, logicalKey)?.ownership_token === ownershipToken,
      renew: (renewedAt = new Date()) => {
        if (!transactionActive) return false;
        db.query("UPDATE active_lock SET renewed_at = ? WHERE lock_key = ? AND ownership_token = ?")
          .run(renewedAt.toISOString(), logicalKey, ownershipToken);
        return readOwnership(db, logicalKey)?.ownership_token === ownershipToken;
      },
    };
    try {
      const result = input.action(lease);
      if (!lease.isOwned()) throw new Error("sqlite_mutation_lock_ownership_lost");
      db.query("DELETE FROM active_lock WHERE lock_key = ? AND ownership_token = ?").run(logicalKey, ownershipToken);
      db.exec("COMMIT");
      transactionActive = false;
      return result;
    } catch (error) {
      if (transactionActive) rollback(db);
      transactionActive = false;
      throw error;
    }
  } finally {
    if (transactionActive) rollback(db);
    db.close(false);
  }
}

export function sqliteMutationLockPath(lockPath: string, lockRoot?: string): string {
  const logicalKey = resolve(lockPath);
  const root = resolve(lockRoot ?? dirname(logicalKey));
  const shard = Number.parseInt(createHash("sha256").update(logicalKey).digest("hex").slice(0, 8), 16) % MUTATION_LOCK_SHARD_COUNT;
  return join(root, "runtime", MUTATION_LOCK_SHARD_DIRECTORY, `mutation-lock-${String(shard).padStart(2, "0")}.sqlite3`);
}

export function sqliteMutationLockShardPaths(lockRoot: string): string[] {
  const dir = join(resolve(lockRoot), "runtime", MUTATION_LOCK_SHARD_DIRECTORY);
  return Array.from({ length: MUTATION_LOCK_SHARD_COUNT }, (_, shard) =>
    join(dir, `mutation-lock-${String(shard).padStart(2, "0")}.sqlite3`));
}

function configureDatabase(db: Database, busyTimeoutMs: number | undefined): void {
  const timeout = Math.max(0, Math.min(60_000, Math.floor(busyTimeoutMs ?? PRODUCTION_LOCK_BUSY_TIMEOUT_MS)));
  db.exec(`PRAGMA busy_timeout = ${timeout}`);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS shard_fence (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      generation INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO shard_fence(singleton, generation) VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS active_lock (
      lock_key TEXT PRIMARY KEY,
      ownership_token TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      renewed_at TEXT NOT NULL
    );
  `);
}

function readOwnership(db: Database, key: string): OwnershipRow | null {
  return db.query<OwnershipRow, [string]>("SELECT ownership_token FROM active_lock WHERE lock_key = ?").get(key);
}

function prepareShardDirectory(path: string, root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const relativePath = relative(root, path);
  let cursor = root;
  for (const part of relativePath.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error("sqlite_mutation_lock_directory_symlink");
    }
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertContained(realpathSync(root), realpathSync(path));
  chmodSync(path, 0o700);
}

function rollback(db: Database): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Connection close is the final crash-safe transaction release.
  }
}

function cleanupLegacyArtifacts(lockPath: string, shardPath: string, lockRoot: string): void {
  for (const path of [
    lockPath,
    `${lockPath}.fence.json`,
    `${lockPath}.sqlite3`,
    `${lockPath}.sqlite3-wal`,
    `${lockPath}.sqlite3-shm`,
  ]) {
    if (path === shardPath || path === `${shardPath}-wal` || path === `${shardPath}-shm`) continue;
    assertLegacyCleanupPathSafe(lockRoot, path);
    try {
      unlinkSync(path);
    } catch {
      // These are pre-sharding artifacts, never current ownership primitives.
    }
  }
}

function assertLegacyCleanupPathSafe(lockRoot: string, target: string): void {
  const root = resolve(lockRoot);
  assertContained(root, target);
  if (lstatSync(root).isSymbolicLink()) throw new Error("sqlite_mutation_lock_root_symlink");
  const realRoot = realpathSync(root);
  const parts = relative(root, dirname(target)).split(sep).filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) break;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error("sqlite_mutation_lock_logical_parent_symlink");
    assertContained(realRoot, realpathSync(cursor));
  }
}

function assertContained(root: string, target: string): void {
  const child = relative(root, target);
  const separator = process.platform === "win32" ? "\\" : "/";
  if (child === "" || child === ".." || child.startsWith(`..${separator}`) || isAbsolute(child)) {
    throw new Error("sqlite_mutation_lock_path_outside_root");
  }
}

function sqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: string; message?: string };
  return candidate.code === "SQLITE_BUSY" || candidate.message?.includes("database is locked") === true;
}
