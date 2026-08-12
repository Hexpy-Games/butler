import { rmSync } from "fs";
import { readTranscriptActivityIndex, transcriptActivityFilePaths } from "./transcript-activity-file-index.ts";
import {
  aggregatePath,
  appendAggregateDelta,
  drainAggregateDeltas,
  hasAggregateDeltas,
  isAggregateLockHeld,
  readAggregate,
  reconcilePendingAggregateDeltas,
  rotateAggregateDeltas,
  withAggregateLock,
  writeCheckpoint,
} from "./transcript-activity-aggregate-persistence.ts";
import {
  applyTranscriptActivityEvent,
  cloneTranscriptActivityAggregate,
  emptyTranscriptActivityAggregate,
  emptyTranscriptActivitySummary,
  mergeTranscriptActivity,
  pruneTranscriptDeliveryFailures,
  summaryFromAccumulator,
} from "./transcript-activity-reducer.ts";
import type { TranscriptActivitySummary } from "./transcript-activity-types.ts";

export type TranscriptActivityAvailability = "available" | "degraded" | "unavailable";

export type TranscriptActivityStatusReason =
  | "transcript_activity_checkpoint_rebuilt"
  | "transcript_activity_checkpoint_unavailable"
  | "transcript_activity_aggregate_lock_contended";

export interface TranscriptActivityStatus {
  summary: TranscriptActivitySummary;
  availability: TranscriptActivityAvailability;
  reason: TranscriptActivityStatusReason | null;
}

export function readTranscriptActivityAggregate(input: {
  butlerData: string;
  nowMs?: number;
}): TranscriptActivitySummary {
  const checkpoint = readAggregate(aggregatePath(input.butlerData));
  if (!checkpoint) return emptyTranscriptActivitySummary();
  const next = cloneTranscriptActivityAggregate(checkpoint);
  pruneTranscriptDeliveryFailures(next, input.nowMs ?? Date.now());
  return summaryFromAccumulator(next);
}

/**
 * Ensure the bounded aggregate exists without touching canonical transcripts
 * when its schema is already valid. Pending lock-fallback deltas are folded
 * into the same aggregate without transcript discovery; only a missing or
 * corrupt aggregate takes the cold rebuild path.
 */
export function ensureTranscriptActivityAggregate(input: {
  butlerData: string;
  nowMs?: number;
}): TranscriptActivitySummary {
  const checkpoint = readAggregate(aggregatePath(input.butlerData));
  if (checkpoint) {
    const reconciled = hasAggregateDeltas(input.butlerData)
      ? reconcilePendingAggregateDeltas(input.butlerData)
      : checkpoint;
    if (reconciled) {
      const next = cloneTranscriptActivityAggregate(reconciled);
      pruneTranscriptDeliveryFailures(next, input.nowMs ?? Date.now());
      return summaryFromAccumulator(next);
    }
  }
  return rebuildTranscriptActivityAggregate(input);
}

/**
 * Startup/recovery-aware reader used by gateway and health paths. A missing
 * or corrupt checkpoint is rebuilt once; callers receive explicit degraded or
 * unavailable state instead of mistaking an empty fallback for zero usage.
 */
export function ensureTranscriptActivityAggregateStatus(input: {
  butlerData: string;
  nowMs?: number;
}): TranscriptActivityStatus {
  const before = readAggregate(aggregatePath(input.butlerData));
  const lockContended = isAggregateLockHeld(input.butlerData);
  const summary = ensureTranscriptActivityAggregate(input);
  const after = readAggregate(aggregatePath(input.butlerData));
  if (!after) {
    return {
      summary,
      availability: "unavailable",
      reason: lockContended
        ? "transcript_activity_aggregate_lock_contended"
        : "transcript_activity_checkpoint_unavailable",
    };
  }
  if (lockContended) {
    return {
      summary,
      availability: "degraded",
      reason: "transcript_activity_aggregate_lock_contended",
    };
  }
  return {
    summary,
    availability: before ? "available" : "degraded",
    reason: before ? null : "transcript_activity_checkpoint_rebuilt",
  };
}

export function recordTranscriptActivityEvent(input: {
  butlerData: string;
  kind: string;
  timestamp?: string;
  payload?: { name?: unknown; ok?: unknown; error?: unknown };
}): void {
  const applied = withAggregateLock(input.butlerData, () => {
    const path = aggregatePath(input.butlerData);
    const aggregate = readAggregate(path) ?? emptyTranscriptActivityAggregate();
    const pending = drainAggregateDeltas(aggregate, input.butlerData);
    applyTranscriptActivityEvent(aggregate, {
      kind: input.kind,
      timestamp: input.timestamp,
      payload: input.payload,
    });
    pruneTranscriptDeliveryFailures(aggregate, Date.now());
    aggregate.updatedAtMs = Date.now();
    const wrote = writeCheckpoint(path, aggregate);
    if (wrote && pending?.removeOnCommit) rmSync(pending.path, { force: true });
    return wrote;
  });
  if (applied !== true) appendAggregateDelta(input);
}

export function rebuildTranscriptActivityAggregate(input: {
  butlerData: string;
  nowMs?: number;
}): TranscriptActivitySummary {
  const summary = withAggregateLock(input.butlerData, () => {
    const pendingDeltaPath = rotateAggregateDeltas(input.butlerData);
    const rebuilt = emptyTranscriptActivityAggregate();
    for (const file of transcriptActivityFilePaths({ butlerData: input.butlerData })) {
      mergeTranscriptActivity(rebuilt, readTranscriptActivityIndex({
        butlerData: input.butlerData,
        transcriptPath: file,
        nowMs: input.nowMs,
      }));
    }
    pruneTranscriptDeliveryFailures(rebuilt, input.nowMs ?? Date.now());
    rebuilt.updatedAtMs = input.nowMs ?? Date.now();
    const wrote = writeCheckpoint(aggregatePath(input.butlerData), rebuilt);
    if (wrote && pendingDeltaPath) rmSync(pendingDeltaPath, { force: true });
    return rebuilt;
  });
  if (summary) return summaryFromAccumulator(summary);
  const checkpoint = readAggregate(aggregatePath(input.butlerData));
  if (checkpoint) {
    const preserved = cloneTranscriptActivityAggregate(checkpoint);
    pruneTranscriptDeliveryFailures(preserved, input.nowMs ?? Date.now());
    return summaryFromAccumulator(preserved);
  }
  return emptyTranscriptActivitySummary();
}
