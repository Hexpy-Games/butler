// Sleep-cycle sub-phase: health checks.
// - SQLite PRAGMA integrity_check
// - log rotation (gzip files older than retention)
// - disk-usage alert (> 80 % of quota)
// - stale-lock + orphan tmp_* sweep
import type { Database } from "bun:sqlite";
import { createRequire } from "node:module";
import { join } from "path";
import { gzipSync } from "zlib";

import { sweepStaleLocks } from "../lib/lock.ts";

const fs: typeof import("fs") = createRequire(import.meta.url)("fs");

export interface HealthOptions {
  db: Database;
  memoryDir: string;
  logsDir: string;
  locksDir: string;
  logRetentionDays: number;
  diskQuotaMb: number;
  now: number;
  alert: (message: string) => void;
  tmpOrphanAgeMs?: number;
}

export interface HealthMetrics {
  integrity_ok: boolean;
  rotated: number;
  pruned_locks: number;
  pruned_tmp_files: number;
  disk_mb: number;
  quota_mb: number;
}

const DEFAULT_TMP_ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

function checkIntegrity(db: Database): boolean {
  try {
    const row = db.query("PRAGMA integrity_check").get() as Record<string, string>;
    return Object.values(row ?? {})[0] === "ok";
  } catch {
    return false;
  }
}

function rotateLogs(logsDir: string, retentionDays: number, now: number): number {
  if (!fs.existsSync(logsDir)) return 0;
  const cutoff = now - retentionDays * 86400_000;
  let rotated = 0;
  for (const name of fs.readdirSync(logsDir)) {
    if (name.endsWith(".gz")) continue;
    if (!/\.(jsonl|log)$/.test(name)) continue;
    const full = join(logsDir, name);
    const mtime = fs.statSync(full).mtimeMs;
    if (mtime > cutoff) continue;
    try {
      const data = fs.readFileSync(full);
      fs.writeFileSync(full + ".gz", gzipSync(data));
      fs.unlinkSync(full);
      rotated += 1;
    } catch {}
  }
  return rotated;
}

function dirSizeBytes(path: string): number {
  if (!fs.existsSync(path)) return 0;
  let total = 0;
  const stack = [path];
  while (stack.length) {
    const cur = stack.pop()!;
    const stat = fs.statSync(cur);
    if (stat.isDirectory()) {
      for (const n of fs.readdirSync(cur)) stack.push(join(cur, n));
    } else {
      total += stat.size;
    }
  }
  return total;
}

function sweepOrphanTmp(dir: string, ageMs: number, now: number): number {
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith("tmp_")) continue;
    const full = join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      if (now - stat.mtimeMs < ageMs) continue;
      fs.unlinkSync(full);
      removed += 1;
    } catch {}
  }
  return removed;
}

export function runHealth(opts: HealthOptions): HealthMetrics {
  const integrity_ok = checkIntegrity(opts.db);
  if (!integrity_ok) {
    // Per spec SC09: integrity failure is a severity:error condition and must
    // alert. The orchestrator additionally logs phase status; here we ensure
    // the signal surfaces to the operator immediately.
    try {
      opts.alert("consolidation-cycle: SQLite integrity_check != 'ok' — see cognition/consolidation/logs/");
    } catch {}
  }
  const rotated = rotateLogs(opts.logsDir, opts.logRetentionDays, opts.now);

  const sizeBytes = dirSizeBytes(opts.memoryDir);
  const disk_mb = sizeBytes / (1024 * 1024);
  if (disk_mb > opts.diskQuotaMb * 0.8) {
    opts.alert(
      `consolidation-cycle: cognition/memory disk usage ${disk_mb.toFixed(1)} MB / quota ${opts.diskQuotaMb} MB`,
    );
  }

  const pruned_locks = fs.existsSync(opts.locksDir)
    ? sweepStaleLocks(opts.locksDir).length
    : 0;
  const pruned_tmp_files = sweepOrphanTmp(
    opts.memoryDir,
    opts.tmpOrphanAgeMs ?? DEFAULT_TMP_ORPHAN_AGE_MS,
    opts.now,
  );

  return {
    integrity_ok,
    rotated,
    pruned_locks,
    pruned_tmp_files,
    disk_mb,
    quota_mb: opts.diskQuotaMb,
  };
}
