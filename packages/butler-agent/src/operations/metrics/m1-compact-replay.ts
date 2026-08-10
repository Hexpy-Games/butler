import { recordOperationalMetric } from "./operational-metrics.ts";
import { M1_COMPACT_REPLAY_FLAG_REVISION } from
  "../../agent/tools/m1-compact-replay.ts";

export const M1_COMPACT_REPLAY_EVENT_NAME = "m1_compact_replay" as const;
export const M1_COMPACT_REPLAY_METRIC_FLAG_REVISION =
  M1_COMPACT_REPLAY_FLAG_REVISION;

export type M1CompactReplayStatus = "ok" | "error" | "skipped";

export interface M1CompactReplayMetadata {
  phaseId: string;
  projectionRevision: string;
  resultRef?: string | null;
  exactRead?: boolean | null;
  duplicateEffect?: boolean | null;
  flagRevision: string;
}

export interface M1CompactReplayMeasurements {
  projectionRevision?: string | null;
  projectionCount?: number | null;
  anchorCount?: number | null;
  replayCount?: number | null;
  exactReadAttempts?: number | null;
  exactReadSuccesses?: number | null;
  exactReadFailures?: number | null;
  resultRef?: string | null;
  exactRead?: boolean | null;
  duplicateEffect?: boolean | null;
}

export interface M1CompactReplayRecorder {
  observe(measurements: M1CompactReplayMeasurements): void;
  finalize(status: M1CompactReplayStatus): void;
}

export function createM1CompactReplayRecorder(input: {
  butlerData?: string;
  env?: Record<string, string | undefined>;
  metadata: M1CompactReplayMetadata;
}): M1CompactReplayRecorder {
  let finalized = false;
  let measurements: Required<M1CompactReplayMeasurements> = {
    projectionRevision: input.metadata.projectionRevision,
    projectionCount: null,
    anchorCount: null,
    replayCount: null,
    exactReadAttempts: null,
    exactReadSuccesses: null,
    exactReadFailures: null,
    resultRef: input.metadata.resultRef ?? null,
    exactRead: input.metadata.exactRead ?? null,
    duplicateEffect: input.metadata.duplicateEffect ?? null,
  };

  return {
    observe(next) {
      if (finalized) return;
      measurements = {
        ...measurements,
        projectionRevision: next.projectionRevision === undefined
          ? measurements.projectionRevision
          : next.projectionRevision,
        projectionCount: next.projectionCount === undefined
          ? measurements.projectionCount
          : next.projectionCount,
        anchorCount: next.anchorCount === undefined
          ? measurements.anchorCount
          : next.anchorCount,
        replayCount: next.replayCount === undefined
          ? measurements.replayCount
          : next.replayCount,
        exactReadAttempts: next.exactReadAttempts === undefined
          ? measurements.exactReadAttempts
          : next.exactReadAttempts,
        exactReadSuccesses: next.exactReadSuccesses === undefined
          ? measurements.exactReadSuccesses
          : next.exactReadSuccesses,
        exactReadFailures: next.exactReadFailures === undefined
          ? measurements.exactReadFailures
          : next.exactReadFailures,
        resultRef: next.resultRef === undefined
          ? measurements.resultRef
          : next.resultRef,
        exactRead: next.exactRead === undefined
          ? measurements.exactRead
          : next.exactRead,
        duplicateEffect: next.duplicateEffect === undefined
          ? measurements.duplicateEffect
          : next.duplicateEffect,
      };
    },
    finalize(status) {
      if (finalized) return;
      finalized = true;
      try {
        recordOperationalMetric({
          category: "tool",
          name: M1_COMPACT_REPLAY_EVENT_NAME,
          status,
          unit: "operation_result",
          dimensions: {
            phaseId: safeIdentifier(input.metadata.phaseId),
            projectionRevision: safeDigest(measurements.projectionRevision),
            resultRef: safeResultRef(measurements.resultRef),
            exactRead: measurements.exactRead,
            duplicateEffect: measurements.duplicateEffect,
            flagRevision: safeIdentifier(input.metadata.flagRevision),
            projectionCount: measurements.projectionCount,
            anchorCount: measurements.anchorCount,
            replayCount: measurements.replayCount,
            exactReadAttempts: measurements.exactReadAttempts,
            exactReadSuccesses: measurements.exactReadSuccesses,
            exactReadFailures: measurements.exactReadFailures,
          },
        }, {
          butlerData: input.butlerData,
          env: input.env,
        });
      } catch {
        // Compact replay telemetry is best effort and cannot block a Turn.
      }
    },
  };
}

function safeIdentifier(value: string): string | null {
  const trimmed = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(trimmed)
    ? trimmed
    : null;
}

function safeDigest(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return /^[a-f0-9]{64}$/.test(trimmed) ? trimmed : null;
}

function safeResultRef(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return /^guided-result-[a-f0-9]{64}$/u.test(trimmed) ? trimmed : null;
}
