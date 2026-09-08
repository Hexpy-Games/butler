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
  unlinkSync,
  openSync,
  closeSync,
  fsyncSync,
  constants as fsConstants,
} from "fs";
import { randomUUID } from "node:crypto";
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
    if (
      entry.job_id &&
      readQueueFile(queueFile).some((queued) => queued.job_id === entry.job_id)
    )
      return;
    appendFileSync(queueFile, JSON.stringify(entry) + "\n");
    fsyncPath(queueFile);
  });
}

export function ack(
  expectedJobId: string,
  butlerData?: string,
): SyncRequest | null {
  const queueFile = butlerData ? memorySyncQueueFile(butlerData) : QUEUE_FILE;
  return withQueueLock(queueFile, () => {
    const entries = readQueueFile(queueFile);
    const first = entries[0];
    if (!first || first.job_id !== expectedJobId) return null;
    replaceQueue(queueFile, entries.slice(1));
    return first;
  });
}

/** Read all entries from the queue. Returns [] if file is missing or empty. */
export function readQueue(): SyncRequest[] {
  return readQueueFile(QUEUE_FILE);
}

/** Remove and return the first entry (FIFO). Atomic via temp-file + rename. */
export function dequeue(butlerData?: string): SyncRequest | null {
  const queueFile = butlerData ? memorySyncQueueFile(butlerData) : QUEUE_FILE;
  if (!existsSync(queueFile)) return null;
  const content = readFileSync(queueFile, "utf-8");
  const lines = content.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  const first = JSON.parse(lines[0]) as SyncRequest;
  const remaining = lines.slice(1);

  if (remaining.length === 0) {
    // Queue is now empty -- remove the file
    unlinkSync(queueFile);
  } else {
    const tmp = queueFile + ".tmp";
    writeFileSync(tmp, remaining.join("\n") + "\n");
    renameSync(tmp, queueFile);
  }

  return first;
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
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function withQueueLock<T>(queueFile: string, run: () => T): T {
  mkdirSync(dirname(queueFile), { recursive: true });
  const lockPath = `${queueFile}.lock`;
  let descriptor: number;
  try {
    descriptor = openSync(
      lockPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error("memory_queue_busy", { cause: error });
  }
  try {
    writeFileSync(
      descriptor,
      JSON.stringify({ pid: process.pid, nonce: randomUUID() }),
    );
    return run();
  } finally {
    closeSync(descriptor);
    unlinkSync(lockPath);
  }
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
