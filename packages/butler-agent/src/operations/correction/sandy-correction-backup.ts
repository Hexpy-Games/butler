import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  sha256,
  stableJson,
  type SandyBackupRecord,
  type SandyFileIdentity,
} from "./sandy-correction-contracts.ts";
import { readFileIdentity } from "./sandy-correction-identity.ts";

export function backupSandyDatabase(input: {
  dbPath: string;
  backupDir: string;
  requestFingerprint: string;
  ownerStopped: boolean;
  ownerManifestSha256?: string;
}): SandyBackupRecord {
  if (!input.ownerStopped) {
    throw new Error("database backup/apply requires the owning runtime to be stopped");
  }
  if (!existsSync(input.dbPath)) throw new Error(`database not found: ${input.dbPath}`);
  mkdirSync(input.backupDir, { recursive: true });
  const familyPaths = [
    input.dbPath,
    `${input.dbPath}-wal`,
    `${input.dbPath}-shm`,
  ].filter((path) => existsSync(path));
  const familyDir = join(input.backupDir, `sandy-correction-${input.requestFingerprint.slice(0, 16)}`);
  mkdirSync(familyDir, { recursive: false });
  const files: SandyFileIdentity[] = [];
  for (const sourcePath of familyPaths) {
    const destination = join(familyDir, basename(sourcePath));
    copyFileSync(sourcePath, destination);
    const sourceIdentity = readFileIdentity(sourcePath, true);
    const copiedIdentity = readFileIdentity(destination, true);
    if (sourceIdentity.sha256 !== copiedIdentity.sha256 || sourceIdentity.size !== copiedIdentity.size) {
      throw new Error(`backup bundle verification failed for ${basename(sourcePath)}`);
    }
    files.push(copiedIdentity);
  }
  const bundleIdentity = sha256(stableJson(files));
  const sqliteSnapshotPath = join(familyDir, `${basename(input.dbPath)}.sqlite-backup`);
  if (existsSync(sqliteSnapshotPath)) {
    throw new Error(`refusing to overwrite existing SQLite snapshot: ${sqliteSnapshotPath}`);
  }
  const source = new Database(input.dbPath, { readonly: true });
  try {
    source.query("VACUUM INTO ?").run(sqliteSnapshotPath);
  } finally {
    source.close();
  }
  const snapshot = new Database(sqliteSnapshotPath, { readonly: true });
  try {
    const integrity = snapshot.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
    if (integrity?.integrity_check !== "ok") {
      throw new Error(`independent SQLite backup failed integrity_check: ${integrity?.integrity_check ?? "missing"}`);
    }
  } finally {
    snapshot.close();
  }
  return {
    bundleDir: familyDir,
    bundleIdentity,
    files,
    sqliteSnapshotPath,
    sqliteSnapshotSha256: sha256(readFileSync(sqliteSnapshotPath)),
    ...(input.ownerManifestSha256 ? { ownerManifestSha256: input.ownerManifestSha256 } : {}),
  };
}
