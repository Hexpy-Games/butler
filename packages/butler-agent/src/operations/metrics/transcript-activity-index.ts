/**
 * Public entrypoint for bounded transcript activity projections.
 *
 * Per-file checkpointing, bounded event reduction, and aggregate persistence
 * are private child capabilities. Product callers use this surface so no
 * request handler can bypass the aggregate owner or its bounded reducer.
 */
export {
  readTranscriptActivityIndex,
  transcriptActivityFilePaths,
} from "./transcript-activity-file-index.ts";
export {
  readTranscriptActivityAggregate,
  ensureTranscriptActivityAggregate,
  ensureTranscriptActivityAggregateStatus,
  recordTranscriptActivityEvent,
  rebuildTranscriptActivityAggregate,
} from "./transcript-activity-aggregate-store.ts";
export type {
  TranscriptActivityAvailability,
  TranscriptActivityStatus,
  TranscriptActivityStatusReason,
} from "./transcript-activity-aggregate-store.ts";
export {
  emptyTranscriptActivitySummary,
  mergeTranscriptActivity,
} from "./transcript-activity-reducer.ts";
export type {
  TranscriptActivitySummary,
  TranscriptToolUsageBucket,
} from "./transcript-activity-types.ts";
