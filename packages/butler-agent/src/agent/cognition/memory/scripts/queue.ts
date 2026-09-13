// JSONL queue utility for memory sync requests.
// Queue file: $BUTLER_DATA/cognition/memory/queue/sync.jsonl
//
// Usage (CLI):
//   bun run queue.ts enqueue --project butler --session abc123 --trigger post_compact
//   bun run queue.ts append  --project butler --session abc123  (alias for enqueue)

import { dirname, join } from "path";
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
} from "fs";
import { createHash, randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { BUTLER_DIR } from "./constants.ts";
import { cognitionMemoryRoot } from "../../paths.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import type { MemorySourceNotice } from "../projection/contracts.ts";

export interface LegacySyncRequest {
  schema_version?: "butler.memory-sync-request.v2";
  job_id?: string;
  scope?: "project" | "global";
  project_id?: string | null;
  conversation_session_id?: string;
  conversation_turn_id?: string;
  inbound_message_id?: string;
  outbound_message_id?: string;
  project: string;
  topic: string | null;
  source: string;
  session_id: string;
  timestamp: string; // ISO-8601
  trigger: string;
}

export interface MemorySyncRequestV3 {
  schema_version: "butler.memory-sync-request.v3";
  job_id: string;
  source: MemorySourceNotice;
  created_at: string;
}

export type SyncRequest = LegacySyncRequest | MemorySyncRequestV3;

// ---------------------------------------------------------------------------
// Queue file path
// ---------------------------------------------------------------------------

const QUEUE_DIR = join(BUTLER_DIR.MEMORY, "queue");

export const QUEUE_FILE = join(QUEUE_DIR, "sync.jsonl");

export function memorySyncQueueFile(butlerData: string): string {
  return join(cognitionMemoryRoot(butlerData), "queue", "sync.jsonl");
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/** Append a sync request as a single JSONL line. Creates directory if missing. */
export function appendToQueue(entry: SyncRequest, butlerData?: string): void {
  const queueFile = butlerData ? memorySyncQueueFile(butlerData) : QUEUE_FILE;
  const queueDir = dirname(queueFile);
  if (!existsSync(queueDir)) {
    mkdirSync(queueDir, { recursive: true });
  }
  withQueueLock(queueFile, () => {
    const durable = withStableObservationId(entry);
    if (readQueueFile(queueFile).some((queued) => queueEntryId(queued) === queueEntryId(durable))) return;
    const existed = existsSync(queueFile);
    appendFileSync(queueFile, JSON.stringify(durable) + "\n", { mode: 0o600 });
    fsyncPath(queueFile);
    if (!existed) fsyncDirectory(dirname(queueFile));
  });
}

export function ack(
  expectedJobId: string,
  butlerData?: string,
): SyncRequest | null {
  const queueFile = butlerData ? memorySyncQueueFile(butlerData) : QUEUE_FILE;
  return withQueueLock(queueFile, () => {
    const entries = readQueueFile(queueFile);
    const index = entries.findIndex((entry) => queueEntryId(entry) === expectedJobId);
    if (index < 0) return null;
    const [removed] = entries.splice(index, 1);
    replaceQueue(queueFile, entries);
    return removed ?? null;
  });
}

/** Read all entries from the queue. Returns [] if file is missing or empty. */
export function readQueue(): SyncRequest[] {
  return readQueueFile(QUEUE_FILE);
}

/** Remove and return the first entry (FIFO). Atomic via temp-file + rename. */
export function dequeue(butlerData?: string): SyncRequest | null {
  const queueFile = butlerData ? memorySyncQueueFile(butlerData) : QUEUE_FILE;
  return withQueueLock(queueFile, () => {
    const entries = readQueueFile(queueFile);
    const first = entries.shift() ?? null;
    if (first) replaceQueue(queueFile, entries);
    return first;
  });
}

/** Return the first entry without removing it. */
export function peek(butlerData?: string): SyncRequest | null {
  const queueFile = butlerData ? memorySyncQueueFile(butlerData) : QUEUE_FILE;
  if (!existsSync(queueFile)) return null;
  const content = readFileSync(queueFile, "utf-8");
  const lines = content.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  return JSON.parse(lines[0]) as SyncRequest;
}

/** Count entries in the queue. */
export function queueLength(): number {
  if (!existsSync(QUEUE_FILE)) return 0;
  const content = readFileSync(QUEUE_FILE, "utf-8").trim();
  if (!content) return 0;
  return content.split("\n").length;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.error(
    "Usage: bun run queue.ts <enqueue|append> --project <name> [--session <id>] [--trigger <t>] [--topic <t>] [--source <s>]",
  );
  process.exit(1);
}

function randomSessionId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function cli(args: string[]): void {
  const command = args[0];
  if (!command || !["enqueue", "append"].includes(command)) {
    printUsage();
  }

  let project: string | undefined;
  let session: string | undefined;
  let trigger = "post_compact";
  let topic: string | null = null;
  let source = "butler";

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--project":
        project = next;
        i++;
        break;
      case "--session":
        session = next;
        i++;
        break;
      case "--trigger":
        trigger = next;
        i++;
        break;
      case "--topic":
        topic = next === "null" ? null : next;
        i++;
        break;
      case "--source":
        source = next;
        i++;
        break;
      default:
        console.error(`Unknown flag: ${arg}`);
        printUsage();
    }
  }

  if (!project) {
    console.error("--project is required");
    printUsage();
  }

  const entry: LegacySyncRequest = {
    project: project!,
    topic,
    source,
    session_id: session || randomSessionId(),
    timestamp: new Date().toISOString(),
    trigger,
  };

  appendToQueue(entry);

  // Print the entry as compact JSON (matches test expectations)
  console.log(JSON.stringify(entry));
}

// Run CLI when executed directly
if (import.meta.main) {
  cli(process.argv.slice(2));
}

function readQueueFile(path: string): SyncRequest[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf-8").trim();
  if (!content) return [];
  return content.split("\n").map((line) => JSON.parse(line) as SyncRequest);
}

export function queueEntryId(entry: SyncRequest): string {
  if (entry.job_id) return entry.job_id;
  const legacy = entry as LegacySyncRequest;
  return `legacy_${createHash("sha256").update(canonicalJson({
    project: legacy.project,
    topic: legacy.topic,
    source: legacy.source,
    session_id: legacy.session_id,
    timestamp: legacy.timestamp,
    trigger: legacy.trigger,
  })).digest("hex").slice(0, 32)}`;
}

function withStableObservationId(entry: SyncRequest): SyncRequest {
  if (entry.job_id) return entry;
  return { ...entry, job_id: queueEntryId(entry) };
}

function replaceQueue(path: string, entries: SyncRequest[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(
    temp,
    entries.map((entry) => JSON.stringify(entry)).join("\n") +
      (entries.length ? "\n" : ""),
  );
  fsyncPath(temp);
  renameSync(temp, path);
  fsyncDirectory(dirname(path));
}

function withQueueLock<T>(queueFile: string, run: () => T): T {
  mkdirSync(dirname(queueFile), { recursive: true });
  const lockDb = new Database(`${queueFile}.coord.sqlite`, { create: true, readwrite: true });
  let transactionStarted = false;
  let committed = false;
  try {
    lockDb.exec("PRAGMA busy_timeout = 0");
    try {
      lockDb.exec("BEGIN EXCLUSIVE");
      transactionStarted = true;
    } catch (error) {
      if (sqliteBusy(error)) throw new Error("memory_queue_busy", { cause: error });
      throw error;
    }
    lockDb.exec(`
      CREATE TABLE IF NOT EXISTS queue_lock_owner(
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        pid INTEGER NOT NULL,
        nonce TEXT NOT NULL,
        acquired_at TEXT NOT NULL
      )
    `);
    lockDb.query(`
      INSERT INTO queue_lock_owner(singleton,pid,nonce,acquired_at)
      VALUES(1,?,?,?)
      ON CONFLICT(singleton) DO UPDATE SET
        pid=excluded.pid,
        nonce=excluded.nonce,
        acquired_at=excluded.acquired_at
    `).run(process.pid, randomUUID(), new Date().toISOString());
    const result = run();
    lockDb.exec("COMMIT");
    committed = true;
    return result;
  } finally {
    if (transactionStarted && !committed) {
      try { lockDb.exec("ROLLBACK"); } catch {}
    }
    lockDb.close();
  }
}

function sqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  return code === "SQLITE_BUSY" || /database is locked|SQLITE_BUSY/iu.test(error.message);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
