import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type {
  ClaimedInboundEvent,
  QueuedInboundEvent,
  RecoverRuntimeInterruptionsSummary,
} from "./inbound-queue.ts";
import {
  atomicWriteInboundQueueRecord,
  inboundQueueDirectory,
  type InboundQueueState,
} from "./inbound-queue-storage.ts";

type QueueRecordReader = (path: string) => QueuedInboundEvent | null;

export function recoverRuntimeInterruptedQueueItems(input: {
  rootDir: string;
  shouldRecover: (event: QueuedInboundEvent) => boolean;
  readRecord: QueueRecordReader;
  now: Date;
}): RecoverRuntimeInterruptionsSummary {
  const summary = { requeued: 0, skipped: 0 };
  const failed = inboundQueueDirectory(input.rootDir, "failed");
  if (!existsSync(failed)) return summary;
  mkdirSync(inboundQueueDirectory(input.rootDir, "pending"), {
    recursive: true,
    mode: 0o700,
  });
  for (const name of readdirSync(failed).filter(isQueueRecord).sort()) {
    const failedPath = join(failed, name);
    const record = input.readRecord(failedPath);
    if (!isRecoverableRuntimeInterruption(input, record)) {
      summary.skipped += 1;
      continue;
    }
    const pendingPath = queueRecordPath(input.rootDir, "pending", record.queueId);
    atomicWriteInboundQueueRecord(pendingPath, {
      ...record,
      processing: undefined,
      metadata: {
        ...record.metadata,
        recoveredFromRuntimeInterruption: true,
        recoveredAt: input.now.toISOString(),
        resumeAfterProcessId: undefined,
      },
    });
    try {
      renameSync(failedPath, `${failedPath}.recovered`);
    } catch {}
    summary.requeued += 1;
  }
  return summary;
}

export function parkQueueItemForProcessReplacement(input: {
  rootDir: string;
  item: ClaimedInboundEvent;
  error: string;
  metadata: Record<string, unknown>;
  now: Date;
}): void {
  const pendingPath = queueRecordPath(input.rootDir, "pending", input.item.queueId);
  atomicWriteInboundQueueRecord(pendingPath, {
    ...input.item,
    processingPath: undefined,
    processing: undefined,
    metadata: {
      ...input.item.metadata,
      ...input.metadata,
      interruptedAt: input.now.toISOString(),
      interruptionError: input.error.slice(0, 500),
      resumeAfterProcessId: process.pid,
      interruptedClaimId: input.item.processing.claimId,
    },
  });
  try {
    renameSync(input.item.path, `${input.item.path}.interrupted`);
  } catch {}
}

function isRecoverableRuntimeInterruption(
  input: Parameters<typeof recoverRuntimeInterruptedQueueItems>[0],
  record: QueuedInboundEvent | null,
): record is QueuedInboundEvent {
  return Boolean(
    record &&
    record.metadata.dispatchStatus === "runtime-interrupted" &&
    input.shouldRecover(record) &&
    !hasCompetingQueueRecord(input.rootDir, record.queueId),
  );
}

function hasCompetingQueueRecord(rootDir: string, queueId: string): boolean {
  const competingStates: InboundQueueState[] = [
    "pending",
    "processing",
    "processed",
  ];
  return competingStates.some((state) =>
    existsSync(queueRecordPath(rootDir, state, queueId)));
}

function queueRecordPath(
  rootDir: string,
  state: InboundQueueState,
  queueId: string,
): string {
  return join(inboundQueueDirectory(rootDir, state), `${queueId}.json`);
}

function isQueueRecord(name: string): boolean {
  return name.endsWith(".json");
}
