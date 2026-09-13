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
import { createLazyConversationProjectionReader } from "../../../../conversation/projection-reader-store.ts";
import type { MemorySourceNotice } from "../../projection/contracts.ts";
import { Database } from "bun:sqlite";
import { readActiveDescriptor, resolveMemoryGeneration } from "../../projection/generation.ts";
import { ingestConversationMemory, withMemoryWriteGateAsync } from "../../projection/ingestion.ts";

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

export interface CanonicalMemoryCatchupState {
  outcomeCursor: string | null;
  recoveredMessageCursor: string | null;
}

export async function runCanonicalMemoryCatchup(input: {
  butlerData: string;
  state: CanonicalMemoryCatchupState;
  limit?: number;
  ingest: (source: MemorySourceNotice, observationId: string) => Promise<void>;
  canonicalDbPath?: string;
}): Promise<{ available: boolean; reason: "canonical_reader_unavailable" | null; scanned: number; ingested: number; wrapped: boolean; state: CanonicalMemoryCatchupState }> {
  const reader = createLazyConversationProjectionReader({ butlerData: input.butlerData, dbPath: input.canonicalDbPath });
  const limit = Math.max(1, Math.min(256, Math.trunc(input.limit ?? 256)));
  let scanned = 0;
  let ingested = 0;
  let wrapped = false;
  const state = { ...input.state };
  try {
    if (!reader.isAvailable()) return { available: false, reason: "canonical_reader_unavailable", scanned, ingested, wrapped, state };
    const outcomeLimit = limit > 1 ? limit - 1 : 1;
    let outcomes = reader.readTurnOutcomes(state.outcomeCursor, outcomeLimit);
    if (outcomes.length === 0 && state.outcomeCursor) {
      state.outcomeCursor = null;
      outcomes = reader.readTurnOutcomes(null, outcomeLimit);
      wrapped = true;
    }
    for (const outcome of outcomes) {
      if (scanned >= limit) break;
      scanned += 1;
      state.outcomeCursor = outcome.id;
      try {
        await input.ingest({ kind: "conversation_turn", session_id: outcome.session_id, turn_id: outcome.turn_id, outcome_generation: outcome.generation }, `catchup:outcome:${outcome.id}`);
        ingested += 1;
      } catch (error) {
        if (!(error instanceof Error && ["memory_source_ineligible", "memory_source_not_terminal"].includes(error.message))) throw error;
      }
    }
    const remaining = limit - scanned;
    if (remaining > 0) {
      let messages = reader.readRecoveredSourceMessages(state.recoveredMessageCursor, remaining);
      if (messages.length === 0 && state.recoveredMessageCursor) {
        state.recoveredMessageCursor = null;
        messages = reader.readRecoveredSourceMessages(null, remaining);
        wrapped = true;
      }
      for (const message of messages) {
        scanned += 1;
        state.recoveredMessageCursor = message.id;
        const sourceHash = new Bun.CryptoHasher("sha256").update(JSON.stringify(message.parts.map((part) => [part.id, part.content_json]))).digest("hex");
        await input.ingest({ kind: "conversation_message", session_id: message.session_id, message_id: message.id, source_hash: sourceHash }, `catchup:message:${message.id}:${sourceHash}`);
        ingested += 1;
      }
    }
    return { available: true, reason: null, scanned, ingested, wrapped, state };
  } finally { reader.close(); }
}

export async function runRebuildGenerationCatchup(input: {
  butlerData: string; generationId: string; canonicalSnapshotId: string;
  limit?: number; signal?: AbortSignal; deadlineAt?: number;
}) {
  const context = {
    butlerData: input.butlerData,
    target: { kind: "rebuild" as const, generation_id: input.generationId, canonical_snapshot_id: input.canonicalSnapshotId },
    signal: input.signal ?? new AbortController().signal,
    deadlineAt: input.deadlineAt,
    waitClass: "background" as const,
  };
  const generation = resolveMemoryGeneration(context);
  if (!generation.canonicalSnapshotPath) throw new Error("memory_snapshot_unavailable");
  const db = new Database(generation.graphPath, { readonly: true });
  let state: CanonicalMemoryCatchupState;
  try {
    state = {
      outcomeCursor: db.query<{ value: string }, []>("SELECT value FROM memory_state WHERE key='canonical_catchup_outcome_cursor'").get()?.value || null,
      recoveredMessageCursor: db.query<{ value: string }, []>("SELECT value FROM memory_state WHERE key='canonical_catchup_message_cursor'").get()?.value || null,
    };
  } finally { db.close(); }
  const result = await runCanonicalMemoryCatchup({
    butlerData: generation.sourceRoot,
    canonicalDbPath: generation.canonicalSnapshotPath,
    state,
    limit: input.limit,
    ingest: async (source, observationId) => {
      await ingestConversationMemory({ context, source, completionJobId: observationId });
    },
  });
  if (!result.available) return { ...result, generationId: generation.generationId };
  await withMemoryWriteGateAsync(context, () => {
    const saveDb = new Database(generation.graphPath);
    try {
      saveDb.transaction(() => {
        resolveMemoryGeneration(context);
        saveDb.query("INSERT INTO memory_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run("canonical_catchup_outcome_cursor", result.state.outcomeCursor ?? "");
        saveDb.query("INSERT INTO memory_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run("canonical_catchup_message_cursor", result.state.recoveredMessageCursor ?? "");
      })();
    } finally { saveDb.close(); }
  });
  return { ...result, generationId: generation.generationId };
}

export async function runServingGenerationCatchup(input: { butlerData: string; limit?: number; signal?: AbortSignal }) {
  const descriptor = readActiveDescriptor(input.butlerData);
  const context = { butlerData: input.butlerData, target: { kind: "active" as const, expected_generation: descriptor.generation_id }, signal: input.signal ?? new AbortController().signal };
  const generation = resolveMemoryGeneration(context);
  const db = new Database(generation.graphPath, { readonly: true });
  let state: CanonicalMemoryCatchupState;
  try {
    state = {
      outcomeCursor: db.query<{ value: string }, []>("SELECT value FROM memory_state WHERE key='canonical_catchup_outcome_cursor'").get()?.value || null,
      recoveredMessageCursor: db.query<{ value: string }, []>("SELECT value FROM memory_state WHERE key='canonical_catchup_message_cursor'").get()?.value || null,
    };
  } finally { db.close(); }
  const result = await runCanonicalMemoryCatchup({ butlerData: input.butlerData, state, limit: input.limit,
    ingest: async (source, observationId) => { await ingestConversationMemory({ context, source, completionJobId: observationId }); } });
  if (!result.available) return { ...result, generationId: generation.generationId };
  await withMemoryWriteGateAsync(context, () => {
    const saveDb = new Database(generation.graphPath);
    try { saveDb.transaction(() => {
      if (readActiveDescriptor(input.butlerData).generation_id !== generation.generationId) throw new Error("memory_generation_changed");
      saveDb.query("INSERT INTO memory_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run("canonical_catchup_outcome_cursor", result.state.outcomeCursor ?? "");
      saveDb.query("INSERT INTO memory_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run("canonical_catchup_message_cursor", result.state.recoveredMessageCursor ?? "");
    })(); } finally { saveDb.close(); }
  });
  return { ...result, generationId: generation.generationId };
}
