// Always-on sync consumer process.
// Watches BUTLER_DATA/cognition/memory/queue/sync.jsonl for new entries,
// processes them FIFO through the sync pipeline, with debounce.
//
// Managed by Butler's native supervisor as `butler-sync-consumer`.
// PID lock: $BUTLER_DATA/cognition/memory/locks/sync-consumer.pid

import {
  ack,
  peek,
  queueEntryId,
  type LegacySyncRequest,
  type SyncRequest,
} from "./queue.ts";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  readFileSync,
  appendFileSync,
  openSync,
  closeSync,
  constants as fsConstants,
} from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { spawnSync, type SpawnSyncReturns } from "child_process";
import { consolidationLockPath, inspectConsolidationLock } from "./lib/lock.ts";
import {
  buildMemoryConversationObservationPayload,
  buildMemoryTranscriptPayload,
  type MemoryTranscriptPayload,
} from "./lib/ingestion.ts";
import { transcriptFileNameForSessionId } from "./lib/session-id.ts";
import { cognitionMemoryRoot } from "../../paths.ts";
import { indexTranscriptLinesForQuery } from "../exact-query.ts";
import { butlerAgentSourcePath } from "../../../../runtime/paths.ts";
import {
  readConversationCompletionObservation,
  type ConversationCompletionObservation,
} from "../../continuity/completion-observation.ts";
import {
  advanceNextMemoryProjection,
  ingestConversationMemory,
  readActiveDescriptor,
} from "../index.ts";
import { runCanonicalMemoryCatchup, runServingGenerationCatchup, type CanonicalMemoryCatchupState } from "./phases/catchup.ts";
import { applyFeedbackQualityOperation } from "../../feedback/buffer.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BUTLER_HOME = process.env.BUTLER_HOME || process.cwd();
const BUTLER_DATA = process.env.BUTLER_DATA || join(homedir(), ".butler");
const MEMORY_DIR = cognitionMemoryRoot(BUTLER_DATA);

const POLL_INTERVAL_MS = 1000;
const DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes
const PID_FILE = join(MEMORY_DIR, "locks", "sync-consumer.pid");
export const CONSOLIDATION_LOCK = consolidationLockPath(BUTLER_DATA);
const BUN = process.execPath;

const SAVE_HOT = butlerAgentSourcePath(
  BUTLER_HOME,
  "agent",
  "cognition",
  "memory",
  "scripts",
  "save_hot.ts",
);
const INDEX_TS = butlerAgentSourcePath(
  BUTLER_HOME,
  "agent",
  "cognition",
  "memory",
  "scripts",
  "index.ts",
);

const DLQ_FILE = join(MEMORY_DIR, "queue", "dead-letter.jsonl");
const FAIL_COUNTER_FILE = join(MEMORY_DIR, "locks", "sync-consumer-fail-count");
const FAIL_ALERT_THRESHOLD = 5;

interface ResolveTranscriptOptions {
  butlerDataDir?: string;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg: string) {
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  console.log(`[${ts}] ${msg}`);
}

function isSafeProvenanceValue(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,80}$/.test(value);
}

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

const lastSync = new Map<string, number>();

function shouldSync(project: string, topic: string | null): boolean {
  const key = `${project}:${topic ?? "_"}`;
  const last = lastSync.get(key) ?? 0;
  if (Date.now() - last < DEBOUNCE_MS) return false;
  lastSync.set(key, Date.now());
  return true;
}

function rollbackDebounce(
  project: string,
  topic: string | null,
  prev: number | undefined,
) {
  const key = `${project}:${topic ?? "_"}`;
  if (prev === undefined) lastSync.delete(key);
  else lastSync.set(key, prev);
}

// ---------------------------------------------------------------------------
// Transcript resolution
// ---------------------------------------------------------------------------

export function resolveLocalTranscriptPath(
  sessionId: string,
  butlerDataDir: string = BUTLER_DATA,
): string | null {
  const candidate = join(
    butlerDataDir,
    "transcripts",
    transcriptFileNameForSessionId(sessionId),
  );
  return existsSync(candidate) ? candidate : null;
}

/**
 * Resolve the transcript jsonl for a given session_id.
 */
export function resolveTranscriptPath(
  sessionId: string,
  options: ResolveTranscriptOptions = {},
): string | null {
  return resolveLocalTranscriptPath(
    sessionId,
    options.butlerDataDir ?? BUTLER_DATA,
  );
}

// ---------------------------------------------------------------------------
// Dead-letter queue
// ---------------------------------------------------------------------------

export interface DLQRecord {
  timestamp: string;
  session_id: string;
  project: string;
  reason: string;
  exit_code: number | null;
  stderr_tail: string;
}

export function appendDLQ(record: DLQRecord, file: string = DLQ_FILE): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(record) + "\n");
  } catch (e: any) {
    log(`DLQ write failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Monotonic fail counter (persisted across restarts)
// ---------------------------------------------------------------------------

export function readFailCounter(file: string = FAIL_COUNTER_FILE): number {
  try {
    const raw = readFileSync(file, "utf8").trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function writeFailCounter(
  n: number,
  file: string = FAIL_COUNTER_FILE,
): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, String(n));
  } catch (e: any) {
    log(`fail-counter write failed: ${e.message}`);
  }
}

export function resetFailCounter(file: string = FAIL_COUNTER_FILE): void {
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {}
}

// Track whether we've already emitted an alert for the current streak.
let alertedForStreak = false;

function emitFailureAlert(count: number): void {
  process.stderr.write(
    `sync-consumer: ${count} consecutive index failures — see ${DLQ_FILE}\n`,
  );
}

// ---------------------------------------------------------------------------
// PID file lock
// ---------------------------------------------------------------------------

function acquireLock(): boolean {
  const lockDir = join(MEMORY_DIR, "locks");
  mkdirSync(lockDir, { recursive: true });

  try {
    const fd = openSync(
      PID_FILE,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    );
    writeFileSync(fd, process.pid.toString());
    closeSync(fd);
    return true;
  } catch (err: any) {
    if (err.code !== "EEXIST") throw err;
    // Lock file exists — check if holder is still alive
    const existingPid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    if (existingPid && !isNaN(existingPid)) {
      try {
        process.kill(existingPid, 0);
        log(
          `Another sync-consumer instance is running (PID ${existingPid}) — exiting`,
        );
        return false;
      } catch (e: any) {
        // EPERM = process exists but owned by another user → treat as alive
        if (e?.code === "EPERM") return false;
        log(`Removing stale lock file (PID ${existingPid} is dead)`);
        try {
          unlinkSync(PID_FILE);
        } catch {}
        try {
          const fd = openSync(
            PID_FILE,
            fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
          );
          writeFileSync(fd, process.pid.toString());
          closeSync(fd);
          return true;
        } catch {
          return false;
        }
      }
    }
    try {
      unlinkSync(PID_FILE);
    } catch {}
    return false;
  }
}

function releaseLock() {
  try {
    unlinkSync(PID_FILE);
  } catch {}
}

// ---------------------------------------------------------------------------
// Sync pipeline
// ---------------------------------------------------------------------------

export interface ProcessDeps {
  runIndex?: (
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => SpawnSyncReturns<string>;
  runSaveHot?: (
    args: string[],
    env: NodeJS.ProcessEnv,
    input: string,
  ) => SpawnSyncReturns<string>;
  resolveTranscript?: (sessionId: string) => string | null;
  onAlert?: (count: number) => void;
  butlerHome?: string;
  butlerData?: string;
  dlqFile?: string;
  failCounterFile?: string;
  saveHotPath?: string;
  indexTsPath?: string;
  ingest?: typeof ingestConversationMemory;
}

export interface ProcessResult {
  dequeue: boolean;
  failCount: number;
  reason?: string;
  generationId?: string;
}

export async function processEntry(
  entry: SyncRequest,
  deps: ProcessDeps = {},
): Promise<ProcessResult> {
  const butlerHome = deps.butlerHome ?? BUTLER_HOME;
  const butlerData = deps.butlerData ?? BUTLER_DATA;
  const env = {
    ...process.env,
    BUTLER_HOME: butlerHome,
    BUTLER_DATA: butlerData,
  };
  const dlqFile =
    deps.dlqFile ??
    join(cognitionMemoryRoot(butlerData), "queue", "dead-letter.jsonl");
  const counterFile =
    deps.failCounterFile ??
    join(cognitionMemoryRoot(butlerData), "locks", "sync-consumer-fail-count");
  const saveHotPath = deps.saveHotPath ?? SAVE_HOT;
  const indexTsPath = deps.indexTsPath ?? INDEX_TS;
  const resolve =
    deps.resolveTranscript ??
    ((id: string) => resolveTranscriptPath(id, { butlerDataDir: butlerData }));
  const onAlert = deps.onAlert ?? emitFailureAlert;
  const completion = canonicalCompletionObservation(entry, butlerData);
  const logProject =
    completion && completion !== "invalid"
      ? (completion.project_id ?? "global")
      : entry.schema_version === "butler.memory-sync-request.v3"
        ? "canonical"
        : entry.project;
  const logSession =
    completion && completion !== "invalid"
      ? completion.runtime_session_id
      : entry.schema_version === "butler.memory-sync-request.v3"
        ? ("session_id" in entry.source ? entry.source.session_id : entry.source.record_id)
        : entry.session_id;
  log(`Processing: ${logProject} (session: ${logSession})`);
  if (completion === "invalid") {
    const reason = "completion_observation_invalid";
    appendDLQ(
      {
        timestamp: new Date().toISOString(),
        session_id: logSession,
        project: logProject,
        reason,
        exit_code: null,
        stderr_tail:
          "canonical completion observation is missing, corrupt, or does not match its queue request",
      },
      dlqFile,
    );
    return { dequeue: true, failCount: readFailCounter(counterFile), reason };
  }
  if (completion) {
    try {
      const descriptor = readActiveDescriptor(butlerData);
      const projection = await (deps.ingest ?? ingestConversationMemory)({
        context: {
          butlerData,
          target: {
            kind: "active",
            expected_generation: descriptor.generation_id,
          },
          signal: new AbortController().signal,
        },
        source: {
          kind: "conversation_turn",
          session_id: completion.conversation_session_id,
          turn_id: completion.conversation_turn_id,
          outcome_generation: completion.outcome_generation,
        },
        completionJobId: completion.job_id,
      });
      return {
        dequeue: projection.source.state === "complete",
        failCount: readFailCounter(counterFile),
        generationId: descriptor.generation_id,
      };
    } catch (error) {
      const reason = safeIngestionFailure(error);
      if (reason === "memory_source_ineligible") {
        return {
          dequeue: true,
          failCount: readFailCounter(counterFile),
          reason,
        };
      }
      appendDLQ(
        {
          timestamp: new Date().toISOString(),
          session_id: logSession,
          project: logProject,
          reason,
          exit_code: null,
          stderr_tail: reason,
        },
        dlqFile,
      );
      return {
        dequeue: false,
        failCount: readFailCounter(counterFile),
        reason,
      };
    }
  }
  if (entry.schema_version === "butler.memory-sync-request.v3") {
    if (entry.source.kind === "explicit_record" && entry.source.record_kind === "feedback") {
      try {
        const operation = await applyFeedbackQualityOperation(butlerData, {
          feedbackId: entry.source.record_id,
          operationId: entry.source.operation_id,
          sourceRevision: entry.source.revision,
        });
        return {
          dequeue: operation.status === "applied" || operation.status === "stale",
          failCount: readFailCounter(counterFile),
          reason: operation.status === "stale" ? "memory_quality_operation_stale" : undefined,
        };
      } catch (error) {
        return {
          dequeue: false,
          failCount: readFailCounter(counterFile),
          reason: safeIngestionFailure(error),
        };
      }
    }
    try {
      const descriptor = readActiveDescriptor(butlerData);
      const projection = await (deps.ingest ?? ingestConversationMemory)({
        context: {
          butlerData,
          target: { kind: "active", expected_generation: descriptor.generation_id },
          signal: new AbortController().signal,
        },
        source: entry.source,
        completionJobId: entry.job_id,
      });
      return {
        dequeue: projection.source.state === "complete",
        failCount: readFailCounter(counterFile),
        generationId: descriptor.generation_id,
      };
    } catch (error) {
      return {
        dequeue: false,
        failCount: readFailCounter(counterFile),
        reason: safeIngestionFailure(error),
      };
    }
  }
  if (!isSafeProvenanceValue(entry.source)) {
    const reason = "unsafe_source_provenance";
    appendDLQ(
      {
        timestamp: new Date().toISOString(),
        session_id: entry.session_id,
        project: entry.project,
        reason,
        exit_code: null,
        stderr_tail: `unsafe source value: ${entry.source}`,
      },
      dlqFile,
    );
    log(`  unsafe source provenance for ${entry.session_id} — routed to DLQ`);
    return { dequeue: true, failCount: readFailCounter(counterFile), reason };
  }

  const payload = resolveMemoryPayload({
    entry,
    butlerData,
    resolve,
    dlqFile,
    counterFile,
    completion: null,
  });
  if ("result" in payload) return payload.result;
  const chunk = payload.chunks[0];
  if (!chunk) {
    const reason = "conversation_empty_or_unparseable";
    appendDLQ(
      {
        timestamp: new Date().toISOString(),
        session_id: entry.session_id,
        project: entry.project,
        reason,
        exit_code: null,
        stderr_tail: `no indexable canonical conversation text found for ${entry.session_id}`,
      },
      dlqFile,
    );
    log(
      `  conversation contained no indexable text for ${entry.session_id} — routed to DLQ`,
    );
    return { dequeue: true, failCount: readFailCounter(counterFile), reason };
  }

  // Legacy queue entries retain their original save_hot/index compatibility path.
  if (existsSync(saveHotPath)) {
    const runSaveHot =
      deps.runSaveHot ??
      ((args, environment) =>
        spawnSync(BUN, args, {
          input: chunk.conversationText,
          encoding: "utf8",
          timeout: 60000,
          env: environment,
        }));
    try {
      const result = runSaveHot(
        [
          "run",
          saveHotPath,
          "--project",
          entry.project,
          "--session-id",
          chunk.sessionId.storage,
          "--type",
          "conversation",
        ],
        env,
        chunk.conversationText,
      );
      if (result.status === 0) log("  save_hot: OK");
      else log(`  save_hot: failed — ${(result.stderr || "").slice(0, 200)}`);
    } catch (error: any) {
      log(`  save_hot: error — ${error.message}`);
    }
  }

  // 3. index.ts with --file (this is the contract fix)
  if (!existsSync(indexTsPath)) {
    log(`  index: ${indexTsPath} missing — skipping`);
    return { dequeue: true, failCount: readFailCounter(counterFile) };
  }

  const runIndex =
    deps.runIndex ??
    ((args, e) =>
      spawnSync(BUN, args, { encoding: "utf8", timeout: 60000, env: e }));

  const normalizedIndexInput = join(
    cognitionMemoryRoot(butlerData),
    "queue",
    "normalized",
    `${chunk.sessionId.storage}.jsonl`,
  );
  mkdirSync(dirname(normalizedIndexInput), { recursive: true });
  writeFileSync(normalizedIndexInput, chunk.indexJsonl, "utf8");

  const args = [
    "run",
    indexTsPath,
    "--file",
    normalizedIndexInput,
    "--project",
    entry.project,
    "--session-id",
    chunk.sessionId.storage,
    "--type",
    "conversation",
    "--source",
    entry.source,
    "--source-session-id",
    chunk.sessionId.original,
    "--strict",
  ];
  if (entry.topic) args.push("--topic", entry.topic);

  let result: SpawnSyncReturns<string>;
  try {
    result = runIndex(args, env);
  } catch (e: any) {
    const n = readFailCounter(counterFile) + 1;
    writeFailCounter(n, counterFile);
    appendDLQ(
      {
        timestamp: new Date().toISOString(),
        session_id: entry.session_id,
        project: entry.project,
        reason: "index_spawn_error",
        exit_code: null,
        stderr_tail: String(e?.message ?? e).slice(-500),
      },
      dlqFile,
    );
    log(`  index: spawn error — ${e.message} (fails=${n}) — kept in queue`);
    if (n >= FAIL_ALERT_THRESHOLD && !alertedForStreak) {
      alertedForStreak = true;
      onAlert(n);
    }
    return { dequeue: false, failCount: n, reason: "index_spawn_error" };
  }

  if (result.status === 0) {
    log(`  index: OK — ${entry.session_id}`);
    if (readFailCounter(counterFile) > 0) {
      resetFailCounter(counterFile);
      alertedForStreak = false;
    }
    return { dequeue: true, failCount: 0 };
  }

  const stderrTail = (result.stderr || "").slice(-500);
  const n = readFailCounter(counterFile) + 1;
  writeFailCounter(n, counterFile);
  appendDLQ(
    {
      timestamp: new Date().toISOString(),
      session_id: entry.session_id,
      project: entry.project,
      reason: "index_nonzero_exit",
      exit_code: result.status,
      stderr_tail: stderrTail,
    },
    dlqFile,
  );
  log(
    `  index: FAILED (exit=${result.status}, fails=${n}) — kept in queue, appended to DLQ`,
  );
  if (n >= FAIL_ALERT_THRESHOLD && !alertedForStreak) {
    alertedForStreak = true;
    onAlert(n);
  }
  return { dequeue: false, failCount: n, reason: "index_nonzero_exit" };
}

function resolveMemoryPayload(input: {
  entry: LegacySyncRequest;
  butlerData: string;
  resolve: (sessionId: string) => string | null;
  dlqFile: string;
  counterFile: string;
  completion: ConversationCompletionObservation | null;
}): MemoryTranscriptPayload | { result: ProcessResult } {
  const canonical = buildMemoryConversationObservationPayload({
    butlerData: input.butlerData,
    sourceSessionId:
      input.completion?.conversation_session_id ?? input.entry.session_id,
    conversationTurnId: input.completion?.conversation_turn_id,
    chunkByGap: false,
  });
  const canonicalIds = new Set(
    canonical.chunks.flatMap((chunk) => chunk.sourceMessageIds),
  );
  const canonicalIdentityMatches =
    !input.completion ||
    (canonicalIds.has(input.completion.inbound_message_id) &&
      canonicalIds.has(input.completion.outbound_message_id));
  if (canonical.chunks.length > 0 && canonicalIdentityMatches) {
    return {
      sourceSessionId:
        canonical.conversationSessionId ?? input.entry.session_id,
      chunks: canonical.chunks,
      messageCount: canonical.messageCount,
    };
  }

  if (input.completion) {
    const reason = "canonical_completion_not_resolved";
    appendDLQ(
      {
        timestamp: new Date().toISOString(),
        session_id: input.entry.session_id,
        project: input.entry.project,
        reason,
        exit_code: null,
        stderr_tail:
          "canonical conversation turn did not contain the completion observation message identities",
      },
      input.dlqFile,
    );
    return {
      result: {
        dequeue: true,
        failCount: readFailCounter(input.counterFile),
        reason,
      },
    };
  }

  const filePath = input.resolve(input.entry.session_id);
  if (!filePath) {
    const reason = "transcript_not_resolved";
    const expectedLocalPath = join(
      input.butlerData,
      "transcripts",
      transcriptFileNameForSessionId(input.entry.session_id),
    );
    appendDLQ(
      {
        timestamp: new Date().toISOString(),
        session_id: input.entry.session_id,
        project: input.entry.project,
        reason,
        exit_code: null,
        stderr_tail: `no canonical conversation or local transcript found for session ${input.entry.session_id} at ${expectedLocalPath}`,
      },
      input.dlqFile,
    );
    log(
      `  conversation/transcript not found for ${input.entry.session_id} — routed to DLQ`,
    );
    return {
      result: {
        dequeue: true,
        failCount: readFailCounter(input.counterFile),
        reason,
      },
    };
  }

  const rawLines = readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim());
  indexTranscriptLinesForQuery({
    butlerData: input.butlerData,
    lines: rawLines,
    transcriptFile: filePath,
  });
  return buildMemoryTranscriptPayload({
    lines: rawLines,
    sourceSessionId: input.entry.session_id,
    chunkByGap: false,
  });
}

function canonicalCompletionObservation(
  entry: SyncRequest,
  butlerData: string,
): ConversationCompletionObservation | null | "invalid" {
  if (
    entry.schema_version !== "butler.memory-sync-request.v2" &&
    entry.schema_version !== "butler.memory-sync-request.v3"
  )
    return null;
  if (!entry.job_id) return "invalid";
  if (entry.schema_version === "butler.memory-sync-request.v3" &&
    entry.source.kind !== "conversation_turn") return null;
  const observation = readConversationCompletionObservation(
    butlerData,
    entry.job_id,
  );
  if (!observation) return "invalid";
  if (entry.schema_version === "butler.memory-sync-request.v3") {
    const source = entry.source;
    return source.kind === "conversation_turn" &&
      source.session_id === observation.conversation_session_id &&
      source.turn_id === observation.conversation_turn_id &&
      source.outcome_generation === observation.outcome_generation
      ? observation
      : "invalid";
  }
  return observation.runtime_session_id === entry.session_id &&
    observation.conversation_session_id === entry.conversation_session_id &&
    observation.conversation_turn_id === entry.conversation_turn_id &&
    observation.inbound_message_id === entry.inbound_message_id &&
    observation.outbound_message_id === entry.outbound_message_id &&
    observation.scope === entry.scope &&
    observation.project_id === (entry.project_id ?? null)
    ? observation
    : "invalid";
}

// Small delay between entries to avoid starving the queue file
// (allows atomic dequeue to complete before next read)
const PROCESS_DELAY_MS = 1500;

// ---------------------------------------------------------------------------
// Consolidation pause
// ---------------------------------------------------------------------------

export interface PollDeps {
  lockPath?: string;
  peek?: () => SyncRequest | null;
  process?: (entry: SyncRequest) => ProcessResult | Promise<ProcessResult>;
  ack?: (expectedJobId: string) => SyncRequest | null;
  advance?: typeof advanceNextMemoryProjection;
  butlerData?: string;
  now?: () => number;
  catchup?: typeof runCanonicalMemoryCatchup;
}

export interface PollResult {
  action: "paused" | "processed" | "dequeued_debounced" | "idle";
  transitioned?: "paused" | "resumed";
}

// Transition state is held at module scope so tests that invoke the poll
// function in sequence observe the same logging contract as main().
let pausedState = false;
let lastCanonicalCatchupAt: number | null = null;
let canonicalCatchupState: CanonicalMemoryCatchupState = { outcomeCursor: null, recoveredMessageCursor: null };

export function resetPauseState(): void {
  pausedState = false;
  lastCanonicalCatchupAt = null;
  canonicalCatchupState = { outcomeCursor: null, recoveredMessageCursor: null };
}

/**
 * Single poll iteration. Extracted from main() so it is testable without
 * timers. Returns a structured result describing what happened.
 *
 * Contract: when the consolidation lock is present, the consumer must not
 * touch peek()/ack(). Debounce map state is preserved across pauses.
 */
export async function pollIteration(deps: PollDeps = {}): Promise<PollResult> {
  const dataRoot = deps.butlerData ?? BUTLER_DATA;
  const lockPath = deps.lockPath ?? consolidationLockPath(dataRoot);
  const p = deps.peek ?? (() => peek(dataRoot));
  const acknowledge = deps.ack ?? ((jobId: string) => ack(jobId, dataRoot));
  const proc =
    deps.process ?? ((entry) => processEntry(entry, { butlerData: dataRoot }));
  const catchupIfDue = async (): Promise<{ generationId?: string; ingested: number }> => {
    const currentNow = (deps.now ?? Date.now)();
    if (lastCanonicalCatchupAt !== null && currentNow - lastCanonicalCatchupAt < 60_000) return { ingested: 0 };
    lastCanonicalCatchupAt = currentNow;
    try {
      const descriptor = readActiveDescriptor(dataRoot);
      const injected = Boolean(deps.catchup);
      const catchup = deps.catchup ? await deps.catchup({ butlerData: dataRoot, state: canonicalCatchupState, limit: 256,
        ingest: async (source, observationId) => { await ingestConversationMemory({ context: { butlerData: dataRoot, target: { kind: "active", expected_generation: descriptor.generation_id }, signal: new AbortController().signal }, source, completionJobId: observationId }); } })
        : await runServingGenerationCatchup({ butlerData: dataRoot, limit: 256 });
      canonicalCatchupState = catchup.state;
      return { generationId: injected ? descriptor.generation_id : (catchup as Awaited<ReturnType<typeof runServingGenerationCatchup>>).generationId, ingested: catchup.ingested };
    } catch (error) {
      if (error instanceof Error && error.message === "memory_generation_unavailable") return { ingested: 0 };
      throw error;
    }
  };

  // Use inspectConsolidationLock (which goes through node:module's createRequire)
  // rather than the top-level existsSync so bun:test mock.module("fs") leakage
  // from unrelated test files cannot falsely pause us.
  const gate = inspectConsolidationLock(lockPath);
  const lockHeld = ["held", "busy", "legacy_blocked", "unavailable"].includes(gate.state);
  if (lockHeld) {
    let transitioned: "paused" | undefined;
    if (!pausedState) {
      pausedState = true;
      transitioned = "paused";
      log("paused-by-consolidation");
    }
    return { action: "paused", transitioned };
  }

  let transitioned: "resumed" | undefined;
  if (pausedState) {
    pausedState = false;
    transitioned = "resumed";
    log("resumed");
  }

  const entry = p();
  if (!entry) {
    try {
      const catchup = await catchupIfDue();
      const descriptor = catchup.generationId ? { generation_id: catchup.generationId } : readActiveDescriptor(dataRoot);
      const progress = await (deps.advance ?? advanceNextMemoryProjection)({
        context: {
          butlerData: dataRoot,
          target: {
            kind: "active",
            expected_generation: descriptor.generation_id,
          },
          signal: new AbortController().signal,
        },
      });
      return { action: progress || catchup.ingested > 0 ? "processed" : "idle", transitioned };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "memory_generation_unavailable"
      ) {
        return { action: "idle", transitioned };
      }
      throw error;
    }
  }

  if (
    entry.schema_version === "butler.memory-sync-request.v2" ||
    entry.schema_version === "butler.memory-sync-request.v3"
  ) {
    let current: SyncRequest | null = entry;
    let registered = 0;
    let generationId: string | undefined;
    while (current && registered < 64) {
      if (
        current.schema_version !== "butler.memory-sync-request.v2" &&
        current.schema_version !== "butler.memory-sync-request.v3"
      ) break;
      const result = await proc(current);
      if (!result.dequeue || !current.job_id) break;
      const removed = acknowledge(current.job_id);
      if (!removed) break;
      registered += 1;
      generationId = result.generationId ?? generationId;
      current = p();
    }
    const catchup = await catchupIfDue();
    generationId = generationId ?? catchup.generationId;
    if (generationId) {
      await (deps.advance ?? advanceNextMemoryProjection)({
        context: {
          butlerData: dataRoot,
          target: { kind: "active", expected_generation: generationId },
          signal: new AbortController().signal,
        },
      });
    }
    return { action: registered > 0 || catchup.ingested > 0 ? "processed" : "idle", transitioned };
  }

  const topicKey = entry.topic ?? "_";
  const debounceKey = `${entry.project}:${topicKey}`;
  const prevLast = lastSync.get(debounceKey);

  if (!shouldSync(entry.project, entry.topic)) {
    log(`Debounced: ${debounceKey} (synced <5min ago)`);
    acknowledge(queueEntryId(entry));
    return { action: "dequeued_debounced", transitioned };
  }

  const result = await proc(entry);
  if (result.dequeue) {
    acknowledge(queueEntryId(entry));
  } else {
    rollbackDebounce(entry.project, entry.topic, prevLast);
  }
  return { action: "processed", transitioned };
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!acquireLock()) {
    process.exit(1);
  }

  let running = true;
  const shutdown = () => {
    log("Shutting down...");
    running = false;
    releaseLock();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  log("sync-consumer started");

  while (running) {
    try {
      const r = await pollIteration();
      if (r.action === "processed") {
        await new Promise((resolve) => setTimeout(resolve, PROCESS_DELAY_MS));
        continue;
      }
      if (r.action === "dequeued_debounced") continue;
    } catch (e: any) {
      log(`Queue error: ${e.message}`);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

function safeIngestionFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return [
    "memory_generation_unavailable",
    "memory_generation_changed",
    "memory_write_busy",
    "memory_source_not_terminal",
    "memory_authoritative_user_source_missing",
    "memory_source_text_missing",
    "memory_source_ineligible",
  ].includes(message)
    ? message
    : "memory_source_registration_failed";
}

if (import.meta.main) {
  await main();
}
