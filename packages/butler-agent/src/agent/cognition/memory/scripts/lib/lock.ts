// One lease gate shared by memory projection and consolidation writers.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { cognitionConsolidationRoot } from "../../../paths.ts";

const fs: typeof import("node:fs") = createRequire(import.meta.url)("node:fs");

export interface LockInfo {
  pid: number;
  startedAt: string;
  host: string;
  owner_nonce: string;
  purpose: string;
}

export type ConsolidationLease = Readonly<{
  owner_nonce: string;
  purpose: string;
}>;

export interface AcquireOptions {
  /** Retained for source compatibility. A live owner is never stolen by age. */
  staleAgeMs?: number;
  purpose?: string;
}

function writePayload(path: string, purpose: string): ConsolidationLease {
  const lease = Object.freeze({ owner_nonce: randomUUID(), purpose });
  const payload: LockInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    host: hostname(),
    owner_nonce: lease.owner_nonce,
    purpose: lease.purpose,
  };
  const descriptor = fs.openSync(
    path,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, JSON.stringify(payload));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return lease;
}

export function inspectConsolidationLock(path: string): LockInfo | null {
  if (!fs.existsSync(path)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(path, "utf8"));
    if (
      typeof value?.pid !== "number" ||
      typeof value?.startedAt !== "string" ||
      typeof value?.host !== "string" ||
      typeof value?.owner_nonce !== "string" ||
      typeof value?.purpose !== "string"
    )
      return null;
    return value as LockInfo;
  } catch {
    return null;
  }
}

export function acquireConsolidationLock(
  path: string,
  options: AcquireOptions = {},
): ConsolidationLease | null {
  fs.mkdirSync(dirname(path), { recursive: true });
  const purpose = options.purpose?.trim() || "memory_write";
  try {
    return writePayload(path, purpose);
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
  }

  // Stale recovery is deliberately fail closed. Node has no portable
  // compare-and-unlink primitive, so removing a path here could unlink a
  // replacement owner's lease between inspection and removal.
  return null;
}

export function releaseConsolidationLock(
  path: string,
  lease: ConsolidationLease,
): void {
  const current = inspectConsolidationLock(path);
  if (
    !current ||
    current.pid !== process.pid ||
    current.host !== hostname() ||
    current.owner_nonce !== lease.owner_nonce ||
    current.purpose !== lease.purpose
  )
    return;
  try {
    fs.unlinkSync(path);
  } catch {}
}

export function sweepStaleLocks(
  _directory: string,
  _options: AcquireOptions = {},
): string[] {
  return [];
}

export function consolidationLockPath(butlerData: string): string {
  return join(
    cognitionConsolidationRoot(butlerData),
    "locks",
    "consolidation.lock",
  );
}
