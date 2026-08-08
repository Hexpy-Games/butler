import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  SANDY_CANONICAL_DB_PATH,
  SANDY_CAPTURE_TURN_IDS,
  SANDY_MONITORING_TURN_IDS,
  SANDY_SESSION_ID,
  SANDY_SOURCE_WORK_ID,
  sha256,
  stableJson,
  type SandyCorrectionInput,
  type SandyDatabaseIdentity,
} from "./sandy-correction-contracts.ts";
import { readDatabaseIdentity, sameStableDatabaseIdentity } from "./sandy-correction-identity.ts";
import { backupSandyDatabase } from "./sandy-correction-backup.ts";
import { readSandyCorrection } from "./sandy-correction-snapshot.ts";

export type SandyOwnerStopManifest = {
  version: "sandy-owner-stop-manifest.v1";
  dbPath: string;
  generatedAt: string;
  dbSha256: string;
  /** Raw DB file content identity; dbSha256 is the semantic identity. */
  dbFileSha256?: string;
  dbFileSize?: number;
  wal: { exists: boolean; size: number; mtimeMs: number; sha256: string | null };
  shm: { exists: boolean; size: number; mtimeMs: number; sha256: string | null };
  ownerPids: number[];
  nonce: string;
  backupBundleIdentity: string;
  sqliteSnapshotSha256: string;
  /** Semantic source evidence captured before the owner-stop backup. */
  sourceSnapshotSha256?: string;
  sourceBindingDigest?: string;
  sourceResultDigest?: string;
  selectedToolJournalCount?: number;
  selectedToolJournalDigest?: string;
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
  const beforeDb = fileState(input.dbPath);
  const beforeWAL = fileState(`${input.dbPath}-wal`);
  const beforeSemantic = readSandyOwnerSemanticSnapshot(input.dbPath);
  const nonce = randomBytes(16).toString("hex");
  const backup = backupSandyDatabase({
    dbPath: input.dbPath,
    backupDir: input.backupDir,
    requestFingerprint: input.requestFingerprint ?? `prepare-${nonce}`,
    ownerStopped: true,
  });
  const ownersAfter = knownButlerOwners();
  const after = readDatabaseIdentity(input.dbPath);
  const afterDb = fileState(input.dbPath);
  const afterWAL = fileState(`${input.dbPath}-wal`);
  const afterSHM = fileState(`${input.dbPath}-shm`);
  const afterSemantic = readSandyOwnerSemanticSnapshot(input.dbPath);
  if (ownersAfter.length > 0 || !sameStableDatabaseIdentity(before, after) ||
    !sameFileState(beforeDb, afterDb) || !sameFileState(beforeWAL, afterWAL) ||
    !sameSemanticSnapshot(beforeSemantic, afterSemantic)) {
    throw new Error("prepare-live database or owner state changed while creating the backup manifest");
  }
  const manifestBase: Omit<SandyOwnerStopManifest, "manifestSha256"> = {
    version: "sandy-owner-stop-manifest.v1",
    dbPath: resolve(SANDY_CANONICAL_DB_PATH),
    generatedAt: new Date().toISOString(),
    dbSha256: after.sha256,
    dbFileSha256: afterDb.sha256 ?? "",
    dbFileSize: afterDb.size,
    wal: afterWAL,
    shm: afterSHM,
    ownerPids: [],
    nonce,
    backupBundleIdentity: backup.bundleIdentity,
    sqliteSnapshotSha256: backup.sqliteSnapshotSha256,
    sourceSnapshotSha256: afterSemantic.beforeSnapshotSha256,
    sourceBindingDigest: afterSemantic.bindingDigest,
    sourceResultDigest: afterSemantic.resultDigest,
    selectedToolJournalCount: afterSemantic.selectedToolJournalCount,
    selectedToolJournalDigest: afterSemantic.selectedToolJournalDigest,
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
  const currentDb = fileState(input.dbPath);
  if (manifest.dbFileSha256 === undefined || manifest.dbFileSize === undefined ||
    !sameFileState({ exists: true, size: manifest.dbFileSize, mtimeMs: 0, sha256: manifest.dbFileSha256 }, currentDb)) {
    throw new Error("owner-stop manifest database file state is stale");
  }
  if (!sameFileState(manifest.wal, currentWAL)) {
    throw new Error("owner-stop manifest WAL state is stale");
  }
  if (!manifest.sourceSnapshotSha256 || !manifest.sourceBindingDigest ||
    !manifest.sourceResultDigest || manifest.selectedToolJournalCount === undefined ||
    !manifest.selectedToolJournalDigest) {
    throw new Error("owner-stop manifest is missing semantic source snapshot evidence");
  }
  const currentSemantic = readSandyOwnerSemanticSnapshot(input.dbPath);
  if (!sameSemanticSnapshot({
    beforeSnapshotSha256: manifest.sourceSnapshotSha256,
    bindingDigest: manifest.sourceBindingDigest,
    resultDigest: manifest.sourceResultDigest,
    selectedToolJournalCount: manifest.selectedToolJournalCount,
    selectedToolJournalDigest: manifest.selectedToolJournalDigest,
  }, currentSemantic)) {
    throw new Error("owner-stop manifest semantic source snapshot is stale");
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
    left.sha256 === right.sha256;
}

type SandyOwnerSemanticSnapshot = {
  beforeSnapshotSha256: string;
  bindingDigest: string;
  resultDigest: string;
  selectedToolJournalCount: number;
  selectedToolJournalDigest: string;
};

function readSandyOwnerSemanticSnapshot(dbPath: string): SandyOwnerSemanticSnapshot {
  const read = readSandyCorrection({
    dbPath,
    sessionId: SANDY_SESSION_ID,
    sourceWorkId: SANDY_SOURCE_WORK_ID,
    monitoringTurnIds: SANDY_MONITORING_TURN_IDS,
    captureTurnIds: SANDY_CAPTURE_TURN_IDS,
  });
  return {
    beforeSnapshotSha256: read.beforeSnapshotSha256,
    bindingDigest: read.bindingDigest,
    resultDigest: read.resultDigest,
    selectedToolJournalCount: read.selectedToolJournalCount,
    selectedToolJournalDigest: read.selectedToolJournalDigest,
  };
}

function sameSemanticSnapshot(
  left: SandyOwnerSemanticSnapshot,
  right: SandyOwnerSemanticSnapshot,
): boolean {
  return left.beforeSnapshotSha256 === right.beforeSnapshotSha256 &&
    left.bindingDigest === right.bindingDigest && left.resultDigest === right.resultDigest &&
    left.selectedToolJournalCount === right.selectedToolJournalCount &&
    left.selectedToolJournalDigest === right.selectedToolJournalDigest;
}
