import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  SANDY_CANONICAL_DB_PATH,
  sha256,
  stableJson,
  type SandyCorrectionInput,
  type SandyDatabaseIdentity,
} from "./sandy-correction-contracts.ts";
import { readDatabaseIdentity, sameStableDatabaseIdentity } from "./sandy-correction-identity.ts";
import { backupSandyDatabase } from "./sandy-correction-backup.ts";

export type SandyOwnerStopManifest = {
  version: "sandy-owner-stop-manifest.v1";
  dbPath: string;
  generatedAt: string;
  dbSha256: string;
  wal: { exists: boolean; size: number; mtimeMs: number; sha256: string | null };
  shm: { exists: boolean; size: number; mtimeMs: number; sha256: string | null };
  ownerPids: number[];
  nonce: string;
  backupBundleIdentity: string;
  sqliteSnapshotSha256: string;
  manifestSha256: string;
};

export type SandyPrepareLiveInput = {
  dbPath: string;
  backupDir: string;
  manifestPath: string;
  requestFingerprint?: string;
};

export function prepareSandyOwnerStop(input: SandyPrepareLiveInput): SandyOwnerStopManifest {
  if (!isCanonicalSandyDatabase(input.dbPath)) {
    throw new Error("prepare-live is only available for the canonical Sandy database path");
  }
  const ownersBefore = knownButlerOwners();
  if (ownersBefore.length > 0) {
    throw new Error("prepare-live refused while a known Butler owner process is running");
  }
  const before = readDatabaseIdentity(input.dbPath);
  const beforeWAL = fileState(`${input.dbPath}-wal`);
  const beforeSHM = fileState(`${input.dbPath}-shm`);
  const nonce = randomBytes(16).toString("hex");
  const backup = backupSandyDatabase({
    dbPath: input.dbPath,
    backupDir: input.backupDir,
    requestFingerprint: input.requestFingerprint ?? `prepare-${nonce}`,
    ownerStopped: true,
  });
  const ownersAfter = knownButlerOwners();
  const after = readDatabaseIdentity(input.dbPath);
  const afterWAL = fileState(`${input.dbPath}-wal`);
  const afterSHM = fileState(`${input.dbPath}-shm`);
  if (ownersAfter.length > 0 || !sameStableDatabaseIdentity(before, after) ||
    !sameFileState(beforeWAL, afterWAL) || !sameFileState(beforeSHM, afterSHM)) {
    throw new Error("prepare-live database or owner state changed while creating the backup manifest");
  }
  const manifestBase: Omit<SandyOwnerStopManifest, "manifestSha256"> = {
    version: "sandy-owner-stop-manifest.v1",
    dbPath: resolve(SANDY_CANONICAL_DB_PATH),
    generatedAt: new Date().toISOString(),
    dbSha256: after.sha256,
    wal: afterWAL,
    shm: afterSHM,
    ownerPids: [],
    nonce,
    backupBundleIdentity: backup.bundleIdentity,
    sqliteSnapshotSha256: backup.sqliteSnapshotSha256,
  };
  const manifest = { ...manifestBase, manifestSha256: sha256(stableJson(manifestBase)) };
  mkdirSync(resolve(input.manifestPath, ".."), { recursive: true });
  writeFileSync(input.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return manifest;
}

export function verifySandyOwnerStop(
  input: SandyCorrectionInput,
  identity: SandyDatabaseIdentity,
): string | undefined {
  if (!isCanonicalSandyDatabase(input.dbPath)) return undefined;
  if (!input.apply) return undefined;
  if (!input.ownerStopped) throw new Error("canonical Sandy apply requires a verified owner-stop manifest");
  const manifestPath = input.ownerStopManifestPath;
  if (!manifestPath) throw new Error("canonical Sandy apply requires --owner-manifest from prepare-live");
  if (knownButlerOwners().length > 0) {
    throw new Error("canonical Sandy apply refused while a known Butler owner process is running");
  }
  const manifest = readManifest(manifestPath);
  const now = Date.now();
  const generatedAt = Date.parse(manifest.generatedAt);
  if (!Number.isFinite(generatedAt) || Math.abs(now - generatedAt) > 5 * 60_000) {
    throw new Error("owner-stop manifest is missing or older than five minutes");
  }
  if (resolve(manifest.dbPath) !== resolve(SANDY_CANONICAL_DB_PATH) ||
    manifest.dbSha256 !== identity.sha256 || manifest.ownerPids.length !== 0 ||
    knownButlerOwners().length > 0 ||
    manifest.manifestSha256 !== manifestDigest(manifest)) {
    throw new Error("owner-stop manifest does not match the current canonical database and stopped-owner state");
  }
  for (const pid of manifest.ownerPids) {
    if (isProcessAlive(pid)) throw new Error(`owner-stop manifest PID is still alive: ${pid}`);
  }
  const currentWAL = fileState(`${input.dbPath}-wal`);
  const currentSHM = fileState(`${input.dbPath}-shm`);
  if (!sameFileState(manifest.wal, currentWAL) || !sameFileState(manifest.shm, currentSHM)) {
    throw new Error("owner-stop manifest WAL/SHM state is stale");
  }
  return manifest.manifestSha256;
}

/** Read only the authenticated manifest identity for replay fingerprinting.
 * The database/WAL freshness checks remain mandatory on a new apply; an
 * already-applied replay validates the immutable audit before returning.
 */
export function readSandyOwnerStopManifestDigest(path: string): string {
  const manifest = readManifest(path);
  if (manifest.manifestSha256 !== manifestDigest(manifest)) {
    throw new Error("owner-stop manifest hash is invalid");
  }
  return manifest.manifestSha256;
}

export function isCanonicalSandyDatabase(dbPath: string): boolean {
  try {
    return resolve(realpathSync(dbPath)) === resolve(realpathSync(SANDY_CANONICAL_DB_PATH));
  } catch {
    return resolve(dbPath) === resolve(SANDY_CANONICAL_DB_PATH);
  }
}

export function manifestDigest(manifest: SandyOwnerStopManifest): string {
  const { manifestSha256: _ignored, ...payload } = manifest;
  return sha256(stableJson(payload));
}

export function redactSandyOwnerStopManifest(manifest: SandyOwnerStopManifest): Record<string, unknown> {
  return {
    manifest_sha256: manifest.manifestSha256,
    backup_bundle_identity: manifest.backupBundleIdentity,
    sqlite_snapshot_sha256: manifest.sqliteSnapshotSha256,
    generated_at: manifest.generatedAt,
    stopped_owner_count: manifest.ownerPids.length,
  };
}

function readManifest(path: string): SandyOwnerStopManifest {
  if (!existsSync(path)) throw new Error(`owner-stop manifest not found: ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("owner-stop manifest is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("owner-stop manifest is invalid");
  const manifest = parsed as Partial<SandyOwnerStopManifest>;
  if (manifest.version !== "sandy-owner-stop-manifest.v1" || typeof manifest.dbPath !== "string" ||
    typeof manifest.generatedAt !== "string" || typeof manifest.dbSha256 !== "string" ||
    !manifest.wal || !manifest.shm || !Array.isArray(manifest.ownerPids) ||
    typeof manifest.manifestSha256 !== "string" || typeof manifest.nonce !== "string" ||
    typeof manifest.backupBundleIdentity !== "string" || typeof manifest.sqliteSnapshotSha256 !== "string") {
    throw new Error("owner-stop manifest is missing required fields");
  }
  return manifest as SandyOwnerStopManifest;
}

export function knownButlerOwners(): number[] {
  let output: string;
  try {
    output = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  } catch {
    return [Number.MAX_SAFE_INTEGER];
  }
  const owners: number[] = [];
  const patterns = [
    /native-butler-main\.ts/i,
    /native-scheduler\.ts/i,
    /app-gateway-cli\.ts/i,
    /mcp-server[\\/]watchdog\.ts/i,
    /(?:sync-consumer|embed-server)\.ts/i,
    /butler-auth-proxy\.mjs/i,
    /Butler\.app[\\/]Contents[\\/]MacOS[\\/]Butler/i,
    /service-control\.sh/i,
  ];
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || /operator-command|sandy-correction|correction sandy/i.test(match[2]) ||
      !patterns.some((pattern) => pattern.test(match[2]))) continue;
    owners.push(pid);
  }
  return owners;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fileState(path: string): SandyOwnerStopManifest["wal"] {
  if (!existsSync(path)) return { exists: false, size: 0, mtimeMs: 0, sha256: null };
  const stat = statSync(path);
  return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs, sha256: sha256(readFileSync(path)) };
}

function sameFileState(
  left: SandyOwnerStopManifest["wal"],
  right: SandyOwnerStopManifest["wal"],
): boolean {
  return left.exists === right.exists && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.sha256 === right.sha256;
}
