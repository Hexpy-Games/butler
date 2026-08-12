export const TRANSCRIPT_ACTIVITY_INDEX_VERSION = 1 as const;
export const MAX_TRANSCRIPT_TOOL_KEYS = 512;
export const MAX_TRANSCRIPT_DELIVERY_FAILURES = 4_096;
export const MAX_TRANSCRIPT_DELIVERY_ERROR_CHARS = 2_048;
export const TRANSCRIPT_DELIVERY_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1_000;

export interface TranscriptToolUsageBucket {
  calls: number;
  results: number;
  successes: number;
  failures: number;
}

export interface TranscriptActivitySummary {
  tools: TranscriptToolUsageBucket;
  byTool: Record<string, TranscriptToolUsageBucket>;
  deliveryFailed: number;
  lastDeliveryError: string | null;
}

export interface TranscriptActivityEvent {
  kind?: unknown;
  timestamp?: unknown;
  payload?: { name?: unknown; ok?: unknown; error?: unknown };
}

export interface DeliveryFailure {
  ts: number;
  error: string | null;
}

export interface TranscriptActivityAccumulator extends TranscriptActivitySummary {
  deliveryFailures: DeliveryFailure[];
  deliveryUnknownCount: number;
  deliveryUnknownLastError: string | null;
  deliveryOverflowCount: number;
  deliveryOverflowLatestTs: number | null;
}

export interface TranscriptActivityCheckpoint extends TranscriptActivityAccumulator {
  version: typeof TRANSCRIPT_ACTIVITY_INDEX_VERSION;
  device: number;
  inode: number;
  byteLength: number;
  mtimeMs: number;
  pendingTailBytes: number;
}

export interface TranscriptActivityAggregateCheckpoint extends TranscriptActivityAccumulator {
  version: typeof TRANSCRIPT_ACTIVITY_INDEX_VERSION;
  updatedAtMs: number;
}
