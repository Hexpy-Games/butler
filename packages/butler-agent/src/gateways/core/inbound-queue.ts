import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readdirSync, renameSync } from "fs";
import { join } from "path";
import type { InboundEnvelope } from "./contracts.ts";
import { settleCancelledDeadOwner } from "./inbound-queue-cancellation.ts";
import {
  parkQueueItemForProcessReplacement,
  recoverRuntimeInterruptedQueueItems,
} from "./inbound-queue-runtime-interruption.ts";
import {
  atomicWriteInboundQueueRecord,
  inboundQueueDirectory,
  readInboundQueueRecord,
  type InboundQueueState,
} from "./inbound-queue-storage.ts";

export interface InboundProcessingLease {
  claimId: string;
  ownerId: string;
  claimedAt: string;
  leaseExpiresAt: string;
}

export interface QueuedInboundEvent {
  version: 1;
  queueId: string;
  envelope: InboundEnvelope;
  enqueuedAt: string;
  attempts: number;
  metadata: Record<string, unknown>;
  processing?: InboundProcessingLease;
}

export interface ClaimedInboundEvent extends QueuedInboundEvent {
  path: string;
  processing: InboundProcessingLease;
}

export interface RecoverStaleProcessingOptions {
  staleAfterMs: number;
  now?: Date;
  ownerId?: string;
  shouldRecover?: (record: QueuedInboundEvent) => boolean;
}

export interface RecoverStaleProcessingSummary {
  requeued: number;
  skipped: number;
}

export interface RecoverRuntimeInterruptionsSummary {
  requeued: number;
  skipped: number;
}

export interface DeadOwnerCancellationSettlementOptions {
  turnId: string;
  queueId: string;
  dispatchClaimId: string;
  now?: Date;
}

export type DeadOwnerCancellationSettlementOutcome =
  | "completed"
  | "already_completed"
  | "processing_claim_missing"
  | "execution_identity_mismatch"
  | "processing_owner_alive"
  | "processing_owner_unknown"
  | "pending_record_exists"
  | "terminal_record_exists";

let enqueueSequence = 0;

function safeQueueId(eventId: string): string {
  return eventId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || randomUUID();
}

function sortableQueueIdPrefix(now: Date): string {
  enqueueSequence = (enqueueSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${now.toISOString().replace(/[-:.]/g, "")}-${String(enqueueSequence).padStart(12, "0")}`;
}

function processingOwnerId(): string {
  return `${process.pid}:${randomUUID()}`;
}

function queueRecordAvailable(record: QueuedInboundEvent, now: Date): boolean {
  if (record.metadata.resumeAfterProcessId === process.pid) return false;
  const notBefore = typeof record.metadata.notBefore === "string"
    ? Date.parse(record.metadata.notBefore)
    : Number.NaN;
  return !Number.isFinite(notBefore) || now.getTime() >= notBefore;
}

export class NativeInboundQueue {
  readonly rootDir: string;
  private readonly ownerId = processingOwnerId();

  constructor(readonly butlerData: string) {
    this.rootDir = join(butlerData, "runtime", "inbound-events");
  }

  protected readQueuedRecord(path: string): QueuedInboundEvent | null {
    return readInboundQueueRecord<QueuedInboundEvent>(path);
  }

  private dir(name: InboundQueueState): string {
    return inboundQueueDirectory(this.rootDir, name);
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
    atomicWriteInboundQueueRecord(join(this.dir("pending"), `${queueId}.json`), record);
    return record;
  }

  claimEligible(
    limit = 10,
    isEligible: (event: QueuedInboundEvent) => boolean,
    now = new Date(),
    leaseMs = 15 * 60 * 1000,
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
      if (!queueRecordAvailable(record, now)) continue;
      if (!isEligible(record)) continue;
      try {
        renameSync(from, to);
      } catch {
        continue;
      }
      const updated: QueuedInboundEvent = {
        ...record,
        attempts: record.attempts + 1,
        processing: {
          claimId: randomUUID(),
          ownerId: this.ownerId,
          claimedAt: now.toISOString(),
          leaseExpiresAt: new Date(now.getTime() + Math.max(1, leaseMs)).toISOString(),
        },
      };
      atomicWriteInboundQueueRecord(to, updated);
      claimed.push({
        ...updated,
        path: to,
        processing: updated.processing!,
      });
    }
    return claimed;
  }

  claim(limit = 10): ClaimedInboundEvent[] {
    return this.claimEligible(limit, () => true);
  }

  recoverStaleProcessing(
    options: RecoverStaleProcessingOptions,
  ): RecoverStaleProcessingSummary {
    const summary: RecoverStaleProcessingSummary = { requeued: 0, skipped: 0 };
    const now = options.now ?? new Date();
    const nowMs = now.getTime();
    const processing = this.dir("processing");
    if (!existsSync(processing)) return summary;
    mkdirSync(this.dir("pending"), { recursive: true, mode: 0o700 });
    const entries = readdirSync(processing)
      .filter((name) => name.endsWith(".json"))
      .sort((a, b) => a.localeCompare(b));
    for (const name of entries) {
      const path = join(processing, name);
      const record = this.readQueuedRecord(path);
      if (!record) {
        summary.skipped += 1;
        continue;
      }
      const leaseExpiresAtMs = Date.parse(record.processing?.leaseExpiresAt ?? "");
      const leaseExpired =
        Number.isFinite(leaseExpiresAtMs) && nowMs >= leaseExpiresAtMs;
      const ownerDead = record.metadata.sameLogicalTurnContinuation === true &&
        processingOwnerLiveness(record.processing?.ownerId) === "dead";
      if (!leaseExpired && !ownerDead) {
        summary.skipped += 1;
        continue;
      }
      if (options.shouldRecover && !options.shouldRecover(record)) {
        summary.skipped += 1;
        continue;
      }
      if (this.hasTerminalRecord(record.queueId)) {
        summary.skipped += 1;
        continue;
      }
      const pendingPath = join(this.dir("pending"), `${record.queueId}.json`);
      if (existsSync(pendingPath)) {
        summary.skipped += 1;
        continue;
      }
      try {
        renameSync(path, pendingPath);
      } catch {
        summary.skipped += 1;
        continue;
      }
      atomicWriteInboundQueueRecord(pendingPath, {
        ...record,
        processing: undefined,
        metadata: {
          ...record.metadata,
          recoveredFromProcessing: true,
          recoveryReason: ownerDead
            ? "processing_owner_dead"
            : "processing_lease_expired",
          recoveredAt: now.toISOString(),
          recoveredBy: options.ownerId ?? this.ownerId,
          previousProcessing: record.processing,
        },
      });
      summary.requeued += 1;
    }
    return summary;
  }

  recoverRuntimeInterruptions(
    shouldRecover: (event: QueuedInboundEvent) => boolean,
    now = new Date(),
  ): RecoverRuntimeInterruptionsSummary {
    return recoverRuntimeInterruptedQueueItems({
      rootDir: this.rootDir,
      shouldRecover,
      readRecord: (path) => this.readQueuedRecord(path),
      now,
    });
  }

  settleDeadOwnerCancellation(
    options: DeadOwnerCancellationSettlementOptions,
  ): DeadOwnerCancellationSettlementOutcome {
    return settleCancelledDeadOwner({
      rootDir: this.rootDir,
      options,
      readRecord: (path) => this.readQueuedRecord(path),
    });
  }

  complete(item: ClaimedInboundEvent, metadata: Record<string, unknown> = {}, now = new Date()): boolean {
    if (!this.ownsProcessingClaim(item)) return false;
    atomicWriteInboundQueueRecord(join(this.dir("processed"), `${item.queueId}.json`), {
      ...item,
      processedAt: now.toISOString(),
      processingPath: undefined,
      processing: undefined,
      metadata: {
        ...item.metadata,
        ...metadata,
        terminalClaimId: item.processing.claimId,
      },
    });
    try {
      renameSync(item.path, `${item.path}.done`);
    } catch {}
    return true;
  }

  fail(item: ClaimedInboundEvent, error: string, metadata: Record<string, unknown> = {}, now = new Date()): boolean {
    if (!this.ownsProcessingClaim(item)) return false;
    atomicWriteInboundQueueRecord(join(this.dir("failed"), `${item.queueId}.json`), {
      ...item,
      failedAt: now.toISOString(),
      processingPath: undefined,
      processing: undefined,
      error: error.slice(0, 500),
      metadata: {
        ...item.metadata,
        ...metadata,
        terminalClaimId: item.processing.claimId,
      },
    });
    try {
      renameSync(item.path, `${item.path}.failed`);
    } catch {}
    return true;
  }

  parkForProcessReplacement(
    item: ClaimedInboundEvent,
    error: string,
    metadata: Record<string, unknown> = {},
    now = new Date(),
  ): boolean {
    if (!this.ownsProcessingClaim(item)) return false;
    parkQueueItemForProcessReplacement({
      rootDir: this.rootDir,
      item,
      error,
      metadata,
      now,
    });
    return true;
  }

  private hasTerminalRecord(queueId: string): boolean {
    return (
      existsSync(join(this.dir("processed"), `${queueId}.json`)) ||
      existsSync(join(this.dir("failed"), `${queueId}.json`))
    );
  }

  private ownsProcessingClaim(item: ClaimedInboundEvent): boolean {
    if (!existsSync(item.path)) return false;
    const current = this.readQueuedRecord(item.path);
    return current?.processing?.claimId === item.processing.claimId;
  }
}

function processingOwnerLiveness(ownerId: string | undefined): "alive" | "dead" | "unknown" {
  const match = /^(\d+):/u.exec(ownerId ?? "");
  if (!match) return "unknown";
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "alive";
  }
}
