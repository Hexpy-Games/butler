import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { InboundEnvelope } from "./contracts.ts";

export interface QueuedInboundEvent {
  version: 1;
  queueId: string;
  envelope: InboundEnvelope;
  enqueuedAt: string;
  attempts: number;
  metadata: Record<string, unknown>;
}

export interface ClaimedInboundEvent extends QueuedInboundEvent {
  path: string;
}

let enqueueSequence = 0;

function safeQueueId(eventId: string): string {
  return eventId.replace(/[^A-Za-z0-9._:-]+/g, "_").slice(0, 120) || randomUUID();
}

function sortableQueueIdPrefix(now: Date): string {
  enqueueSequence = (enqueueSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${now.toISOString().replace(/[-:.]/g, "")}-${String(enqueueSequence).padStart(12, "0")}`;
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export class NativeInboundQueue {
  readonly rootDir: string;

  constructor(readonly butlerData: string) {
    this.rootDir = join(butlerData, "runtime", "inbound-events");
  }

  protected readQueuedRecord(path: string): QueuedInboundEvent | null {
    return readJson<QueuedInboundEvent>(path);
  }

  private dir(name: "pending" | "processing" | "processed" | "failed"): string {
    return join(this.rootDir, name);
  }

  enqueue(
    envelope: InboundEnvelope,
    metadata: Record<string, unknown> = {},
    now = new Date(),
  ): QueuedInboundEvent {
    const queueId = `${sortableQueueIdPrefix(now)}-${safeQueueId(envelope.eventId)}-${randomUUID().slice(0, 8)}`;
    const record: QueuedInboundEvent = {
      version: 1,
      queueId,
      envelope,
      enqueuedAt: now.toISOString(),
      attempts: 0,
      metadata,
    };
    atomicWriteJson(join(this.dir("pending"), `${queueId}.json`), record);
    return record;
  }

  claimEligible(
    limit = 10,
    isEligible: (event: QueuedInboundEvent) => boolean,
  ): ClaimedInboundEvent[] {
    const pending = this.dir("pending");
    if (!existsSync(pending)) return [];
    mkdirSync(this.dir("processing"), { recursive: true, mode: 0o700 });
    const claimed: ClaimedInboundEvent[] = [];
    const pendingEntries = readdirSync(pending)
      .filter((name) => name.endsWith(".json"))
      .sort((a, b) => a.localeCompare(b));

    for (const name of pendingEntries) {
      if (claimed.length >= limit) break;
      const from = join(pending, name);
      const to = join(this.dir("processing"), name);
      const record = this.readQueuedRecord(from);
      if (!record) continue;
      if (!isEligible(record)) continue;
      try {
        renameSync(from, to);
      } catch {
        continue;
      }
      const updated: QueuedInboundEvent = {
        ...record,
        attempts: record.attempts + 1,
      };
      atomicWriteJson(to, updated);
      claimed.push({
        ...updated,
        path: to,
      });
    }
    return claimed;
  }

  claim(limit = 10): ClaimedInboundEvent[] {
    return this.claimEligible(limit, () => true);
  }

  complete(item: ClaimedInboundEvent, metadata: Record<string, unknown> = {}, now = new Date()): void {
    atomicWriteJson(join(this.dir("processed"), `${item.queueId}.json`), {
      ...item,
      processedAt: now.toISOString(),
      processingPath: undefined,
      metadata: {
        ...item.metadata,
        ...metadata,
      },
    });
    try {
      renameSync(item.path, `${item.path}.done`);
    } catch {}
  }

  fail(item: ClaimedInboundEvent, error: string, metadata: Record<string, unknown> = {}, now = new Date()): void {
    atomicWriteJson(join(this.dir("failed"), `${item.queueId}.json`), {
      ...item,
      failedAt: now.toISOString(),
      processingPath: undefined,
      error: error.slice(0, 500),
      metadata: {
        ...item.metadata,
        ...metadata,
      },
    });
    try {
      renameSync(item.path, `${item.path}.failed`);
    } catch {}
  }
}
