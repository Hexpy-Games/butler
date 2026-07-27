import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import type {
  DeadOwnerCancellationSettlementOptions,
  DeadOwnerCancellationSettlementOutcome,
  QueuedInboundEvent,
} from "./inbound-queue.ts";
import {
  atomicWriteInboundQueueRecord,
  inboundQueueDirectory,
} from "./inbound-queue-storage.ts";

type QueueRecordReader = (path: string) => QueuedInboundEvent | null;

export function settleCancelledDeadOwner(input: {
  rootDir: string;
  options: DeadOwnerCancellationSettlementOptions;
  readRecord: QueueRecordReader;
}): DeadOwnerCancellationSettlementOutcome {
  const { rootDir, options, readRecord } = input;
  if (!validQueueToken(options.queueId) || !validQueueToken(options.dispatchClaimId)) {
    return "execution_identity_mismatch";
  }
  const processingPath = queueRecordPath(rootDir, "processing", options.queueId);
  const settlingPath = `${processingPath}.cancelling-${options.dispatchClaimId}`;
  const processedPath = queueRecordPath(rootDir, "processed", options.queueId);
  const processed = readRecord(processedPath);
  if (processed) return settleExistingTerminal(processed, settlingPath, processingPath, options);
  if (existsSync(queueRecordPath(rootDir, "failed", options.queueId))) {
    return "terminal_record_exists";
  }

  const existingSettlingRecord = readRecord(settlingPath);
  const record = existingSettlingRecord ?? readRecord(processingPath);
  const initialDisposition = cancellationDisposition(record, options);
  if (initialDisposition) return initialDisposition;
  const pendingPath = queueRecordPath(rootDir, "pending", options.queueId);
  if (existsSync(pendingPath)) return "pending_record_exists";

  if (!existingSettlingRecord) {
    const claimed = claimCancellationSettlement({
      processingPath,
      settlingPath,
      pendingPath,
      processedPath,
      readRecord,
      options,
    });
    if (claimed) return claimed;
  }
  const current = readRecord(settlingPath);
  const currentDisposition = cancellationDisposition(current, options);
  if (currentDisposition) return currentDisposition;
  commitCancellation(processingPath, settlingPath, processedPath, current!, options);
  return "completed";
}

function claimCancellationSettlement(input: {
  processingPath: string;
  settlingPath: string;
  pendingPath: string;
  processedPath: string;
  readRecord: QueueRecordReader;
  options: DeadOwnerCancellationSettlementOptions;
}): DeadOwnerCancellationSettlementOutcome | null {
  try {
    renameSync(input.processingPath, input.settlingPath);
    return null;
  } catch {
    if (existsSync(input.pendingPath)) return "pending_record_exists";
    const racedTerminal = input.readRecord(input.processedPath);
    if (racedTerminal && cancelledTerminalMatches(racedTerminal, input.options)) {
      return "already_completed";
    }
    return "processing_claim_missing";
  }
}

function commitCancellation(
  processingPath: string,
  settlingPath: string,
  processedPath: string,
  record: QueuedInboundEvent,
  options: DeadOwnerCancellationSettlementOptions,
): void {
  try {
    atomicWriteInboundQueueRecord(processedPath, {
      ...record,
      processedAt: (options.now ?? new Date()).toISOString(),
      processingPath: undefined,
      processing: undefined,
      metadata: {
        ...record.metadata,
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
}

function cancellationDisposition(
  record: QueuedInboundEvent | null,
  options: DeadOwnerCancellationSettlementOptions,
): DeadOwnerCancellationSettlementOutcome | null {
  if (!record) return "processing_claim_missing";
  if (!processingIdentityMatches(record, options)) return "execution_identity_mismatch";
  const ownerLiveness = processingOwnerLiveness(record.processing?.ownerId);
  if (ownerLiveness === "alive") return "processing_owner_alive";
  if (ownerLiveness === "unknown") return "processing_owner_unknown";
  return null;
}

function settleExistingTerminal(
  record: QueuedInboundEvent,
  settlingPath: string,
  processingPath: string,
  options: DeadOwnerCancellationSettlementOptions,
): DeadOwnerCancellationSettlementOutcome {
  if (!cancelledTerminalMatches(record, options)) return "terminal_record_exists";
  try {
    if (existsSync(settlingPath)) renameSync(settlingPath, `${processingPath}.done`);
  } catch {}
  return "already_completed";
}

function queueRecordPath(
  rootDir: string,
  state: "pending" | "processing" | "processed" | "failed",
  queueId: string,
): string {
  return join(inboundQueueDirectory(rootDir, state), `${queueId}.json`);
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
