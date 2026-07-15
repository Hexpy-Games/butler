import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { InboundEnvelope } from "./contracts.ts";

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

function queueRecordAvailable(record: QueuedInboundEvent, now: Date): boolean {
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

  enqueueIdempotent(
    envelope: InboundEnvelope,
    metadata: Record<string, unknown>,
    idempotencyKey: string,
    now = new Date(),
  ): QueuedInboundEvent {
    const key = idempotencyKey.trim();
    if (!key) throw new Error("inbound_queue_idempotency_key_missing");
    const queueId = [
      now.toISOString().replace(/[-:.]/g, ""),
      safeQueueId(envelope.eventId),
      createHash("sha256").update(key).digest("hex").slice(0, 16),
    ].join("-");
    for (const directory of ["pending", "processing", "processed", "failed"] as const) {
      const existing = this.readQueuedRecord(join(this.dir(directory), `${queueId}.json`));
      if (existing) return existing;
    }
    const record: QueuedInboundEvent = {
      version: 1,
      queueId,
      envelope,
      enqueuedAt: now.toISOString(),
      attempts: 0,
      metadata: {
        ...metadata,
        idempotencyKey: key,
      },
    };
    atomicWriteJson(join(this.dir("pending"), `${queueId}.json`), record);
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
      atomicWriteJson(to, updated);
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
      atomicWriteJson(pendingPath, {
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

  settleDeadOwnerCancellation(
    options: DeadOwnerCancellationSettlementOptions,
  ): DeadOwnerCancellationSettlementOutcome {
    if (
      !validQueueToken(options.queueId) ||
      !validQueueToken(options.dispatchClaimId)
    ) return "execution_identity_mismatch";
    const processingPath = join(
      this.dir("processing"),
      `${options.queueId}.json`,
    );
    const settlingPath = deadOwnerCancellationSettlingPath(
      processingPath,
      options.dispatchClaimId,
    );
    const processedPath = join(
      this.dir("processed"),
      `${options.queueId}.json`,
    );
    const processed = this.readQueuedRecord(processedPath);
    if (processed) {
      if (!cancelledTerminalMatches(processed, options)) {
        return "terminal_record_exists";
      }
      try {
        if (existsSync(settlingPath)) {
          renameSync(settlingPath, `${processingPath}.done`);
        }
      } catch {}
      return "already_completed";
    }
    if (existsSync(join(this.dir("failed"), `${options.queueId}.json`))) {
      return "terminal_record_exists";
    }

    const existingSettlingRecord = this.readQueuedRecord(settlingPath);
    const record = existingSettlingRecord ?? this.readQueuedRecord(processingPath);
    if (!record) return "processing_claim_missing";
    if (!processingIdentityMatches(record, options)) {
      return "execution_identity_mismatch";
    }
    const ownerLiveness = processingOwnerLiveness(record.processing?.ownerId);
    if (ownerLiveness === "alive") return "processing_owner_alive";
    if (ownerLiveness === "unknown") return "processing_owner_unknown";
    const pendingPath = join(this.dir("pending"), `${options.queueId}.json`);
    if (existsSync(pendingPath)) {
      return "pending_record_exists";
    }

    if (!existingSettlingRecord) {
      try {
        renameSync(processingPath, settlingPath);
      } catch {
        if (existsSync(pendingPath)) return "pending_record_exists";
        const racedTerminal = this.readQueuedRecord(processedPath);
        if (racedTerminal && cancelledTerminalMatches(racedTerminal, options)) {
          return "already_completed";
        }
        return "processing_claim_missing";
      }
    }
    const current = this.readQueuedRecord(settlingPath);
    if (!current || !processingIdentityMatches(current, options)) {
      return "execution_identity_mismatch";
    }
    const currentOwnerLiveness = processingOwnerLiveness(
      current.processing?.ownerId,
    );
    if (currentOwnerLiveness === "alive") return "processing_owner_alive";
    if (currentOwnerLiveness === "unknown") return "processing_owner_unknown";
    try {
      atomicWriteJson(processedPath, {
        ...current,
        processedAt: (options.now ?? new Date()).toISOString(),
        processingPath: undefined,
        processing: undefined,
        metadata: {
          ...current.metadata,
          dispatchStatus: "cancelled-principal-turn",
          handled: false,
          cancelled: true,
          terminalClaimId: options.dispatchClaimId,
        },
      });
    } catch (error) {
      try {
        renameSync(settlingPath, processingPath);
      } catch {}
      throw error;
    }
    try {
      renameSync(settlingPath, `${processingPath}.done`);
    } catch {}
    return "completed";
  }

  complete(item: ClaimedInboundEvent, metadata: Record<string, unknown> = {}, now = new Date()): boolean {
    if (!this.ownsProcessingClaim(item)) return false;
    atomicWriteJson(join(this.dir("processed"), `${item.queueId}.json`), {
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
    atomicWriteJson(join(this.dir("failed"), `${item.queueId}.json`), {
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

function validQueueToken(token: string): boolean {
  return /^[A-Za-z0-9._:-]{1,240}$/u.test(token);
}

function deadOwnerCancellationSettlingPath(
  processingPath: string,
  dispatchClaimId: string,
): string {
  return `${processingPath}.cancelling-${dispatchClaimId}`;
}

function processingIdentityMatches(
  record: QueuedInboundEvent,
  options: DeadOwnerCancellationSettlementOptions,
): boolean {
  return record.queueId === options.queueId &&
    record.envelope.routingHints?.turnId === options.turnId &&
    record.processing?.claimId === options.dispatchClaimId;
}

function cancelledTerminalMatches(
  record: QueuedInboundEvent,
  options: DeadOwnerCancellationSettlementOptions,
): boolean {
  return record.queueId === options.queueId &&
    record.envelope.routingHints?.turnId === options.turnId &&
    record.metadata.dispatchStatus === "cancelled-principal-turn" &&
    record.metadata.cancelled === true &&
    record.metadata.terminalClaimId === options.dispatchClaimId;
}
