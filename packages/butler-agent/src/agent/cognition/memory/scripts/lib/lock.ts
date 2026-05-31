// Consolidation lock utility.
// Shared by the consolidation-cycle orchestrator (acquire/release) and sync-consumer (check only).
//
// fs is resolved via createRequire so bun:test `mock.module("fs", ...)` cycles
// in unrelated test files (notably compact-compaction-fix.test.ts) cannot
// leave us holding a stale `unlinkSync` reference after their mock.restore().
import { createRequire } from "node:module";
import { dirname, join } from "path";
import { hostname } from "os";
import { cognitionConsolidationRoot } from "../../../paths.ts";

const fs: typeof import("fs") = createRequire(import.meta.url)("fs");

export interface LockInfo {
  pid: number;
  startedAt: string;
  host: string;
}

export interface AcquireOptions {
  staleAgeMs?: number;
}

const DEFAULT_STALE_AGE_MS = 30 * 60 * 1000;

function writePayload(path: string): void {
  const payload: LockInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    host: hostname(),
  };
  const fd = fs.openSync(
    path,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
  );
  fs.writeFileSync(fd, JSON.stringify(payload));
  fs.closeSync(fd);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    if (e?.code === "EPERM") return true;
    return false;
  }
}

export function inspectConsolidationLock(path: string): LockInfo | null {
  if (!fs.existsSync(path)) return null;
  try {
    const raw = fs.readFileSync(path, "utf8");
    const obj = JSON.parse(raw);
    if (typeof obj?.pid !== "number" || typeof obj?.startedAt !== "string") return null;
    return obj as LockInfo;
  } catch {
    return null;
  }
}

function isStale(info: LockInfo, staleAgeMs: number): boolean {
  if (!isAlive(info.pid)) return true;
  const age = Date.now() - new Date(info.startedAt).getTime();
  return Number.isFinite(age) && age > staleAgeMs;
}

export function acquireConsolidationLock(
  path: string,
  opts: AcquireOptions = {},
): boolean {
  const staleAgeMs = opts.staleAgeMs ?? DEFAULT_STALE_AGE_MS;
  fs.mkdirSync(dirname(path), { recursive: true });

  try {
    writePayload(path);
    return true;
  } catch (err: any) {
    if (err?.code !== "EEXIST") throw err;
  }

  const info = inspectConsolidationLock(path);
  if (!info || isStale(info, staleAgeMs)) {
    try {
      fs.unlinkSync(path);
    } catch {}
    try {
      writePayload(path);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function releaseConsolidationLock(path: string): void {
  try {
    fs.unlinkSync(path);
  } catch {}
}

export function sweepStaleLocks(
  directory: string,
  opts: AcquireOptions = {},
): string[] {
  if (!fs.existsSync(directory)) return [];
  const staleAgeMs = opts.staleAgeMs ?? DEFAULT_STALE_AGE_MS;
  const removed: string[] = [];
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith(".lock")) continue;
    const full = join(directory, name);
    const info = inspectConsolidationLock(full);
    if (!info || isStale(info, staleAgeMs)) {
      try {
        fs.unlinkSync(full);
        removed.push(name);
      } catch {}
    }
  }
  return removed;
}

export function consolidationLockPath(butlerData: string): string {
  return join(cognitionConsolidationRoot(butlerData), "locks", "consolidation.lock");
}
