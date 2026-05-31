// Sleep-cycle sub-phase: catchup sync.
// Reconciles persisted session offsets against the current file size of each
// transcript and drives the existing save_hot → index.ts pipeline directly
// for unprocessed byte ranges. The sync queue is intentionally bypassed —
// sync-consumer.ts is paused by the orchestrator's consolidation lock, so
// enqueuing here would just stall behind the lock.
import { createRequire } from "node:module";
import {
  loadOffsets,
  saveOffsets,
  type OffsetMap,
  type SessionOffset,
} from "../lib/sessions.ts";

const fs: typeof import("fs") = createRequire(import.meta.url)("fs");

export interface CatchupSession {
  path: string;
  sessionId: string;
  /** The key used inside the offset map (e.g. `butler:<sessionId>` or project name). */
  offsetKey: string;
}

export interface DrainArgs {
  sessionId: string;
  offsetKey: string;
  path: string;
  fromByte: number;
  toByte: number;
}

export interface DrainResult {
  ok: boolean;
  linesProcessed: number;
}

export interface CatchupOptions {
  offsetFile: string;
  sessions: CatchupSession[];
  drain: (args: DrainArgs) => DrainResult;
  /** Bytes of slack allowed for a session whose transcript was written recently. */
  liveFileToleranceBytes?: number;
  /** Window in ms within which the mtime counts as "actively writing". */
  liveFileWindowMs?: number;
  now?: () => number;
}

export interface CatchupMetrics {
  sessions_scanned: number;
  sessions_skipped_live: number;
  bytes_reconciled: number;
  drain_failures: number;
}

const DEFAULT_LIVE_BYTES = 64 * 1024;
const DEFAULT_LIVE_WINDOW_MS = 2 * 60 * 1000;

export function runCatchup(opts: CatchupOptions): CatchupMetrics {
  const offsets: OffsetMap = loadOffsets(opts.offsetFile);
  const liveBytes = opts.liveFileToleranceBytes ?? DEFAULT_LIVE_BYTES;
  const liveWindowMs = opts.liveFileWindowMs ?? DEFAULT_LIVE_WINDOW_MS;
  const now = (opts.now ?? Date.now)();

  const metrics: CatchupMetrics = {
    sessions_scanned: 0,
    sessions_skipped_live: 0,
    bytes_reconciled: 0,
    drain_failures: 0,
  };

  for (const session of opts.sessions) {
    if (!fs.existsSync(session.path)) continue;
    metrics.sessions_scanned += 1;

    const stat = fs.statSync(session.path);
    const size = stat.size;
    const prior: SessionOffset = offsets[session.offsetKey] ?? {
      sessionId: session.sessionId,
      lastLine: -1,
      byteOffset: 0,
    };

    let fromByte = prior.sessionId === session.sessionId ? prior.byteOffset : 0;

    // Shrunk / rewritten transcript — restart from zero.
    if (fromByte > size) fromByte = 0;

    const delta = size - fromByte;
    if (delta <= 0) {
      // Offset already matches file size.
      offsets[session.offsetKey] = { sessionId: session.sessionId, lastLine: prior.lastLine, byteOffset: size };
      continue;
    }

    const ageMs = now - stat.mtimeMs;
    const isLive = ageMs >= 0 && ageMs < liveWindowMs;
    if (isLive && delta < liveBytes) {
      metrics.sessions_skipped_live += 1;
      continue;
    }

    const result = opts.drain({
      sessionId: session.sessionId,
      offsetKey: session.offsetKey,
      path: session.path,
      fromByte,
      toByte: size,
    });

    if (!result.ok) {
      metrics.drain_failures += 1;
      continue;
    }

    metrics.bytes_reconciled += delta;
    offsets[session.offsetKey] = {
      sessionId: session.sessionId,
      lastLine: Math.max(prior.lastLine, result.linesProcessed + (prior.sessionId === session.sessionId ? prior.lastLine + 1 : 0)),
      byteOffset: size,
    };
  }

  saveOffsets(offsets, opts.offsetFile);
  return metrics;
}
