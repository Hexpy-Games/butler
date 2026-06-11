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

function safeQueueId(eventId: string): string {
  return eventId.replace(/[^A-Za-z0-9._:-]+/g, "_").slice(0, 120) || randomUUID();
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

  private dir(name: "pending" | "processing" | "processed" | "failed"): string {
    return join(this.rootDir, name);
  }

  enqueue(
    envelope: InboundEnvelope,
    metadata: Record<string, unknown> = {},
    now = new Date(),
  ): QueuedInboundEvent {
    const queueId = `${safeQueueId(envelope.eventId)}-${randomUUID().slice(0, 8)}`;
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
    for (const entry of readdirSync(pending).filter((name) => name.endsWith(".json")).sort()) {
      if (claimed.length >= limit) break;
      const from = join(pending, entry);
      const to = join(this.dir("processing"), entry);
      const record = readJson<QueuedInboundEvent>(from);
      if (!record || !isEligible(record)) continue;
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
