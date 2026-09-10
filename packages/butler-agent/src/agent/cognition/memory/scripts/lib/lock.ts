// One lease gate shared by memory projection and consolidation writers.
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { Database } from "bun:sqlite";
import { cognitionConsolidationRoot } from "../../../paths.ts";

const fs: typeof import("node:fs") = createRequire(import.meta.url)("node:fs");
const FENCE_SCHEMA = "butler.memory-write-fence.v1";
const COORDINATOR_VERSION = 1;
const GATE_TABLE = "memory_write_gate";

export interface LockInfo { pid: number; startedAt: string; host: string; owner_nonce: string; purpose: string }
type FenceInfo = { schema: typeof FENCE_SCHEMA; format_version: 1; fence_id: string; created_at: string };
type CoordinatorMeta = { format_version: number; fence_sha256: string | null; last_owner_json: string | null };
export type ConsolidationLease = Readonly<{ owner_nonce: string; purpose: string }>;
export type ConsolidationLockState = "free" | "initialization_available" | "held" | "busy" | "legacy_blocked" | "unavailable";
export type ConsolidationLockInspection = {
  state: ConsolidationLockState; pid: number | null; owner: LockInfo | null;
  last_observed_owner: LockInfo | null; coordinator_path: string; reason: string | null;
};
export interface AcquireOptions {
  staleAgeMs?: number;
  purpose?: string;
  waitClass?: "interactive" | "background";
  deadlineAt?: number;
  signal?: AbortSignal;
}
type PrivateLease = { db: Database; path: string; info: LockInfo; released: boolean };
const privateLeases = new WeakMap<ConsolidationLease, PrivateLease>();
const localLeases = new Map<string, ConsolidationLease>();

function coordinatorPath(path: string): string { return `${path}.coord.sqlite`; }
function digest(bytes: string): string { return createHash("sha256").update(bytes).digest("hex"); }
function isBusy(error: unknown): boolean {
  const value = error as { code?: string; message?: string };
  return value?.code === "SQLITE_BUSY" || /database is locked|SQLITE_BUSY/iu.test(value?.message ?? "");
}
function parseLegacy(value: unknown): LockInfo | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return typeof row.pid === "number" && Number.isSafeInteger(row.pid) && row.pid > 0 &&
    typeof row.startedAt === "string" && typeof row.host === "string" &&
    typeof row.owner_nonce === "string" && typeof row.purpose === "string"
    ? {
        pid: row.pid,
        startedAt: row.startedAt,
        host: row.host,
        owner_nonce: row.owner_nonce,
        purpose: row.purpose,
      }
    : null;
}
function parseFence(value: unknown): FenceInfo | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return row.schema === FENCE_SCHEMA && row.format_version === 1 &&
    typeof row.fence_id === "string" && Boolean(row.fence_id) && typeof row.created_at === "string"
    ? { schema: FENCE_SCHEMA, format_version: 1, fence_id: row.fence_id, created_at: row.created_at }
    : null;
}
function definitelyDeadLocalProcess(info: LockInfo): boolean {
  if (info.host !== hostname()) return false;
  try { process.kill(info.pid, 0); return false; }
  catch (error: any) { return error?.code === "ESRCH"; }
}
function readFenceBytes(path: string): string | null {
  try { return fs.readFileSync(path, "utf8"); }
  catch (error: any) { if (error?.code === "ENOENT") return null; throw error; }
}
function classifyUnboundFence(path: string): { available: boolean; reason: string | null; bytes: string | null; legacy: LockInfo | null } {
  const bytes = readFenceBytes(path);
  if (bytes === null) return { available: true, reason: null, bytes: null, legacy: null };
  try {
    const value = JSON.parse(bytes);
    if (parseFence(value)) return { available: true, reason: null, bytes, legacy: null };
    const legacy = parseLegacy(value);
    if (!legacy) return { available: false, reason: "invalid_fence", bytes, legacy: null };
    return definitelyDeadLocalProcess(legacy)
      ? { available: true, reason: null, bytes, legacy }
      : { available: false, reason: "legacy_owner_live_or_uncertain", bytes, legacy };
  } catch { return { available: false, reason: "invalid_fence", bytes, legacy: null }; }
}
function fsyncDirectory(path: string): void {
  const descriptor = fs.openSync(dirname(path), fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
function fsyncFile(path: string): void {
  const descriptor = fs.openSync(path, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
function installFence(path: string): string | null {
  fs.mkdirSync(dirname(path), { recursive: true });
  const bytes = JSON.stringify({ schema: FENCE_SCHEMA, format_version: 1, fence_id: randomUUID(), created_at: new Date().toISOString() } satisfies FenceInfo);
  try {
    const descriptor = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fsyncDirectory(path);
    return bytes;
  } catch (error: any) { if (error?.code === "EEXIST") return null; throw error; }
}
function readCoordinatorMeta(db: Database): CoordinatorMeta | null {
  const table = db.query<{ found: number }, [string]>("SELECT 1 found FROM sqlite_master WHERE type='table' AND name=?").get(GATE_TABLE);
  if (!table) return null;
  return db.query<CoordinatorMeta, []>(`SELECT format_version,fence_sha256,last_owner_json FROM ${GATE_TABLE} WHERE singleton=1`).get() ?? null;
}
function readKnownCoordinator(path: string): { meta: CoordinatorMeta; last: LockInfo | null } | null {
  const cPath = coordinatorPath(path);
  if (!fs.existsSync(cPath)) return null;
  const db = new Database(cPath, { readonly: true });
  try {
    const mode = db.query<Record<string, string>, []>("PRAGMA journal_mode").get();
    if (String(mode ? Object.values(mode)[0] : "").toLowerCase() !== "delete") throw new Error("memory_write_gate_unavailable");
    const meta = readCoordinatorMeta(db);
    if (!meta || meta.format_version !== COORDINATOR_VERSION) throw new Error("memory_write_gate_unavailable");
    const bytes = readFenceBytes(path);
    if (meta.fence_sha256 !== null && (bytes === null || digest(bytes) !== meta.fence_sha256)) {
      throw new Error("memory_write_gate_unavailable");
    }
    let last: LockInfo | null = null;
    try { last = meta.last_owner_json ? parseLegacy(JSON.parse(meta.last_owner_json)) : null; } catch {}
    return { meta, last };
  } finally { db.close(); }
}
function initializeCoordinator(path: string): boolean {
  const cPath = coordinatorPath(path);
  if (fs.existsSync(cPath)) return false;
  fs.mkdirSync(dirname(cPath), { recursive: true });
  const tempPath = `${cPath}.init-${process.pid}-${randomUUID()}`;
  let db: Database | null = null;
  try {
    db = new Database(tempPath, { create: true });
    db.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE");
    db.exec(`CREATE TABLE ${GATE_TABLE} (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), format_version INTEGER NOT NULL,
      fence_sha256 TEXT, last_owner_json TEXT)`);
    db.query(`INSERT INTO ${GATE_TABLE}(singleton,format_version,fence_sha256,last_owner_json) VALUES(1,?,?,NULL)`)
      .run(COORDINATOR_VERSION, null);
    db.exec("COMMIT");
    db.close();
    db = null;
    const descriptor = fs.openSync(tempPath, fs.constants.O_RDONLY);
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    try { fs.linkSync(tempPath, cPath); }
    catch (error: any) { if (error?.code === "EEXIST") return false; throw error; }
    fsyncDirectory(cPath);
    return true;
  } catch (error) {
    try { db?.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    try { db?.close(); } finally { try { fs.unlinkSync(tempPath); } catch {} }
  }
}

function bindCoordinatorFence(path: string): boolean {
  const cPath = coordinatorPath(path);
  const db = new Database(cPath);
  let transaction = false;
  try {
    db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    transaction = true;
    const meta = readCoordinatorMeta(db);
    if (!meta || meta.format_version !== COORDINATOR_VERSION) throw new Error("memory_write_gate_unavailable");
    if (meta.fence_sha256 !== null) {
      const bytes = readFenceBytes(path);
      if (bytes === null || digest(bytes) !== meta.fence_sha256) throw new Error("memory_write_gate_unavailable");
      db.exec("ROLLBACK");
      transaction = false;
      return true;
    }
    let fence = classifyUnboundFence(path);
    if (!fence.available) throw new Error(fence.reason === "legacy_owner_live_or_uncertain"
      ? "memory_write_legacy_blocked" : "memory_write_gate_unavailable");
    if (fence.bytes === null) {
      installFence(path);
      fence = classifyUnboundFence(path);
    }
    if (!fence.available || fence.bytes === null) throw new Error(fence.reason === "legacy_owner_live_or_uncertain"
      ? "memory_write_legacy_blocked" : "memory_write_gate_unavailable");
    fsyncFile(path);
    fsyncDirectory(path);
    fsyncDirectory(cPath);
    const durableFenceBytes = readFenceBytes(path);
    if (durableFenceBytes === null || durableFenceBytes !== fence.bytes) throw new Error("memory_write_gate_unavailable");
    db.query(`UPDATE ${GATE_TABLE} SET fence_sha256=? WHERE singleton=1 AND fence_sha256 IS NULL`)
      .run(digest(durableFenceBytes));
    db.exec("COMMIT");
    transaction = false;
    return true;
  } catch (error) {
    if (transaction) try { db.exec("ROLLBACK"); } catch {}
    if (isBusy(error)) return false;
    throw error;
  } finally { db.close(); }
}
function tryAcquire(path: string, options: AcquireOptions): ConsolidationLease | null {
  if (options.signal?.aborted || (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt)) return null;
  let known: ReturnType<typeof readKnownCoordinator>;
  try { known = readKnownCoordinator(path); }
  catch (error) { if (isBusy(error)) return null; throw error; }
  if (!known) {
    try { initializeCoordinator(path); }
    catch (error) { if (isBusy(error)) return null; throw error; }
  }
  let initialized: ReturnType<typeof readKnownCoordinator>;
  try { initialized = readKnownCoordinator(path); }
  catch (error) { if (isBusy(error)) return null; throw error; }
  if (!initialized) throw new Error("memory_write_gate_unavailable");
  if (initialized.meta.fence_sha256 === null && !bindCoordinatorFence(path)) return null;
  if (options.signal?.aborted || (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt)) return null;
  let verified: ReturnType<typeof readKnownCoordinator>;
  try { verified = readKnownCoordinator(path); }
  catch (error) { if (isBusy(error)) return null; throw error; }
  if (!verified) throw new Error("memory_write_gate_unavailable");
  let db: Database;
  try { db = new Database(coordinatorPath(path)); }
  catch (error) { if (isBusy(error)) return null; throw error; }
  try { db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); }
  catch (error) { db.close(); if (isBusy(error)) return null; throw error; }
  if (options.signal?.aborted || (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt)) {
    try { db.exec("ROLLBACK"); } finally { db.close(); }
    return null;
  }
  try {
    const current = readCoordinatorMeta(db);
    const bytes = readFenceBytes(path);
    if (!current || current.format_version !== COORDINATOR_VERSION || bytes === null || digest(bytes) !== current.fence_sha256) {
      throw new Error("memory_write_gate_unavailable");
    }
    const purpose = options.purpose?.trim() || "projection";
    const lease = Object.freeze({ owner_nonce: randomUUID(), purpose });
    const info: LockInfo = { pid: process.pid, startedAt: new Date().toISOString(), host: hostname(), owner_nonce: lease.owner_nonce, purpose };
    db.query(`UPDATE ${GATE_TABLE} SET last_owner_json=? WHERE singleton=1`).run(JSON.stringify(info));
    privateLeases.set(lease, { db, path, info, released: false });
    localLeases.set(path, lease);
    return lease;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    try { db.close(); } catch {}
    throw error;
  }
}

export function acquireConsolidationLock(path: string, options: AcquireOptions = {}): ConsolidationLease | null { return tryAcquire(path, options); }
export async function acquireConsolidationLockAsync(path: string, options: AcquireOptions = {}): Promise<ConsolidationLease | null> {
  const defaultBudget = options.waitClass === "background" ? 30_000 : 5_000;
  const deadlineAt = Math.min(options.deadlineAt ?? Number.POSITIVE_INFINITY, Date.now() + defaultBudget);
  const bounded = { ...options, deadlineAt };
  for (;;) {
    if (bounded.signal?.aborted) throw new Error("memory_write_aborted");
    const lease = tryAcquire(path, bounded);
    if (lease) return lease;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return null;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(done, Math.min(20, remaining));
      function done() { bounded.signal?.removeEventListener("abort", abort); resolve(); }
      function abort() { clearTimeout(timer); bounded.signal?.removeEventListener("abort", abort); reject(new Error("memory_write_aborted")); }
      bounded.signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
export function assertConsolidationLease(path: string, lease: ConsolidationLease): void {
  const owned = privateLeases.get(lease);
  if (!owned || owned.released || owned.path !== path || owned.info.owner_nonce !== lease.owner_nonce || owned.info.purpose !== lease.purpose)
    throw new Error("memory_write_lease_invalid");
}
export function inspectConsolidationLock(path: string): ConsolidationLockInspection {
  const cPath = coordinatorPath(path);
  const local = localLeases.get(path);
  if (local) {
    const owner = privateLeases.get(local)?.info ?? null;
    return { state: "held", pid: owner?.pid ?? null, owner, last_observed_owner: owner, coordinator_path: cPath, reason: null };
  }
  if (!fs.existsSync(cPath)) {
    const fence = classifyUnboundFence(path);
    if (!fence.available) return { state: fence.legacy ? "legacy_blocked" : "unavailable", pid: fence.legacy?.pid ?? null,
      owner: fence.legacy, last_observed_owner: fence.legacy, coordinator_path: cPath, reason: fence.reason };
    return { state: "initialization_available", pid: null, owner: null, last_observed_owner: null, coordinator_path: cPath, reason: null };
  }
  let known: ReturnType<typeof readKnownCoordinator>;
  try { known = readKnownCoordinator(path); }
  catch (error) { return { state: isBusy(error) ? "busy" : "unavailable", pid: null, owner: null, last_observed_owner: null,
    coordinator_path: cPath, reason: isBusy(error) ? "coordinator_busy" : "coordinator_unavailable" }; }
  if (!known) return { state: "unavailable", pid: null, owner: null, last_observed_owner: null, coordinator_path: cPath, reason: "coordinator_unavailable" };
  let db: Database;
  try { db = new Database(cPath); }
  catch (error) { return { state: isBusy(error) ? "busy" : "unavailable", pid: null, owner: null, last_observed_owner: known.last,
    coordinator_path: cPath, reason: isBusy(error) ? "coordinator_busy" : "coordinator_unavailable" }; }
  try {
    db.exec("PRAGMA busy_timeout=0");
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec("ROLLBACK");
      if (known.meta.fence_sha256 === null) {
        const fence = classifyUnboundFence(path);
        if (!fence.available) return { state: fence.legacy ? "legacy_blocked" : "unavailable", pid: fence.legacy?.pid ?? null,
          owner: fence.legacy, last_observed_owner: fence.legacy ?? known.last, coordinator_path: cPath, reason: fence.reason };
        return { state: "initialization_available", pid: null, owner: null, last_observed_owner: known.last,
          coordinator_path: cPath, reason: null };
      }
      return { state: "free", pid: null, owner: null, last_observed_owner: known.last, coordinator_path: cPath, reason: null };
    } catch (error) {
      if (!isBusy(error)) throw error;
      return { state: "busy", pid: null, owner: null, last_observed_owner: known.last, coordinator_path: cPath, reason: "coordinator_busy" };
    }
  } catch (error) { return { state: isBusy(error) ? "busy" : "unavailable", pid: null, owner: null, last_observed_owner: known.last,
    coordinator_path: cPath, reason: isBusy(error) ? "coordinator_busy" : "coordinator_unavailable" }; }
  finally { try { db.close(); } catch {} }
}
export function releaseConsolidationLock(path: string, lease: ConsolidationLease, commit = true): void {
  const owned = privateLeases.get(lease);
  if (!owned || owned.released || owned.path !== path || owned.info.owner_nonce !== lease.owner_nonce || owned.info.purpose !== lease.purpose) return;
  owned.released = true;
  let commitError: unknown;
  try { owned.db.exec(commit ? "COMMIT" : "ROLLBACK"); }
  catch (error) { commitError = error; try { owned.db.exec("ROLLBACK"); } catch {} }
  let closeError: unknown;
  try { owned.db.close(); } catch (error) { closeError = error; }
  finally { privateLeases.delete(lease); if (localLeases.get(path) === lease) localLeases.delete(path); }
  if (commitError) throw commitError;
  if (closeError) throw closeError;
}
export function sweepStaleLocks(_directory: string, _options: AcquireOptions = {}): string[] { return []; }
export function consolidationLockPath(butlerData: string): string {
  return join(cognitionConsolidationRoot(butlerData), "locks", "consolidation.lock");
}
