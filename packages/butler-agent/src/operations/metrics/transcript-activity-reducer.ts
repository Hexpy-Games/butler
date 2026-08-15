import {
  MAX_TRANSCRIPT_DELIVERY_ERROR_CHARS,
  MAX_TRANSCRIPT_DELIVERY_FAILURES,
  MAX_TRANSCRIPT_TOOL_KEYS,
  TRANSCRIPT_DELIVERY_FAILURE_WINDOW_MS,
  TRANSCRIPT_ACTIVITY_INDEX_VERSION,
  type TranscriptActivityAccumulator,
  type TranscriptActivityAggregateCheckpoint,
  type TranscriptActivityEvent,
  type TranscriptActivitySummary,
  type TranscriptActivityCheckpoint,
  type TranscriptToolUsageBucket,
} from "./transcript-activity-types.ts";

function emptyToolBucket(): TranscriptToolUsageBucket {
  return { calls: 0, results: 0, successes: 0, failures: 0 };
}

export function emptyTranscriptActivitySummary(): TranscriptActivitySummary {
  return { tools: emptyToolBucket(), byTool: {}, deliveryFailed: 0, lastDeliveryError: null };
}

export function emptyTranscriptActivityCheckpoint(): TranscriptActivityCheckpoint {
  return {
    version: TRANSCRIPT_ACTIVITY_INDEX_VERSION,
    device: 0,
    inode: 0,
    byteLength: 0,
    mtimeMs: 0,
    pendingTailBytes: 0,
    deliveryFailures: [],
    deliveryUnknownCount: 0,
    deliveryUnknownLastError: null,
    deliveryOverflowCount: 0,
    deliveryOverflowLatestTs: null,
    ...emptyTranscriptActivitySummary(),
  };
}

export function emptyTranscriptActivityAggregate(): TranscriptActivityAggregateCheckpoint {
  return {
    version: TRANSCRIPT_ACTIVITY_INDEX_VERSION,
    updatedAtMs: 0,
    deliveryFailures: [],
    deliveryUnknownCount: 0,
    deliveryUnknownLastError: null,
    deliveryOverflowCount: 0,
    deliveryOverflowLatestTs: null,
    ...emptyTranscriptActivitySummary(),
  };
}

export function summaryFromAccumulator(summary: TranscriptActivityAccumulator): TranscriptActivitySummary {
  return {
    tools: summary.tools,
    byTool: summary.byTool,
    deliveryFailed: summary.deliveryFailed,
    lastDeliveryError: summary.lastDeliveryError,
  };
}

export function cloneTranscriptActivityAggregate(
  summary: TranscriptActivityAggregateCheckpoint,
): TranscriptActivityAggregateCheckpoint {
  return {
    ...summary,
    tools: { ...summary.tools },
    byTool: Object.fromEntries(
      Object.entries(summary.byTool).map(([name, bucket]) => [name, { ...bucket }]),
    ),
    deliveryFailures: summary.deliveryFailures.map((failure) => ({ ...failure })),
  };
}

function addTool(
  summary: TranscriptActivityAccumulator,
  name: string,
  kind: "tool_call" | "tool_result",
  ok: boolean,
): void {
  const bucket = summary.tools;
  if (kind === "tool_call") bucket.calls += 1;
  else {
    bucket.results += 1;
    if (ok) bucket.successes += 1;
    else bucket.failures += 1;
  }
  const key = Object.prototype.hasOwnProperty.call(summary.byTool, name) ||
    Object.keys(summary.byTool).length < MAX_TRANSCRIPT_TOOL_KEYS
    ? name
    : "__other__";
  const byTool = summary.byTool[key] ??= emptyToolBucket();
  if (kind === "tool_call") byTool.calls += 1;
  else {
    byTool.results += 1;
    if (ok) byTool.successes += 1;
    else byTool.failures += 1;
  }
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function applyTranscriptActivityEvent(
  summary: TranscriptActivityAccumulator,
  event: TranscriptActivityEvent,
): void {
  const payload = event.payload;
  if (event.kind === "tool_call" || event.kind === "tool_result") {
    const name = typeof payload?.name === "string" ? payload.name.trim() : "";
    if (name) addTool(summary, name, event.kind, payload?.ok !== false);
  }
  if (event.kind !== "delivery" || payload?.ok !== false) return;
  const error = typeof payload.error === "string" && payload.error.trim()
    ? payload.error.trim().slice(0, MAX_TRANSCRIPT_DELIVERY_ERROR_CHARS)
    : null;
  const timestamp = parseTimestamp(event.timestamp);
  if (timestamp === null) {
    summary.deliveryUnknownCount += 1;
    if (error) summary.deliveryUnknownLastError = error;
    return;
  }
  summary.deliveryFailures.push({ ts: timestamp, error });
  summary.deliveryFailures.sort((left, right) => left.ts - right.ts);
  while (summary.deliveryFailures.length > MAX_TRANSCRIPT_DELIVERY_FAILURES) {
    const removed = summary.deliveryFailures.shift();
    summary.deliveryOverflowCount += 1;
    if (removed) {
      summary.deliveryOverflowLatestTs = summary.deliveryOverflowLatestTs === null
        ? removed.ts
        : Math.max(summary.deliveryOverflowLatestTs, removed.ts);
    }
  }
}

export function applyTranscriptActivityLine(
  summary: TranscriptActivityAccumulator,
  line: string,
): void {
  if (!line.trim()) return;
  try {
    applyTranscriptActivityEvent(summary, JSON.parse(line) as TranscriptActivityEvent);
  } catch {
    // A malformed diagnostic record contributes no usage or delivery event.
  }
}

export function pruneTranscriptDeliveryFailures(
  summary: TranscriptActivityAccumulator,
  nowMs: number,
): void {
  const cutoff = nowMs - TRANSCRIPT_DELIVERY_FAILURE_WINDOW_MS;
  summary.deliveryFailures = summary.deliveryFailures.filter((failure) => failure.ts >= cutoff);
  if (
    summary.deliveryOverflowLatestTs !== null &&
    summary.deliveryOverflowLatestTs < cutoff
  ) {
    summary.deliveryOverflowCount = 0;
    summary.deliveryOverflowLatestTs = null;
  }
  summary.deliveryFailed = summary.deliveryUnknownCount +
    summary.deliveryFailures.length +
    (summary.deliveryOverflowLatestTs !== null && summary.deliveryOverflowLatestTs >= cutoff
      ? summary.deliveryOverflowCount
      : 0);
  const latest = [
    ...summary.deliveryFailures,
    ...(summary.deliveryUnknownLastError
      ? [{ ts: Number.POSITIVE_INFINITY, error: summary.deliveryUnknownLastError }]
      : []),
  ].sort((left, right) => right.ts - left.ts)[0];
  summary.lastDeliveryError = latest?.error ?? null;
}

export function mergeTranscriptActivity(
  target: TranscriptActivityAccumulator,
  source: TranscriptActivityAccumulator,
): void {
  target.tools.calls += source.tools.calls;
  target.tools.results += source.tools.results;
  target.tools.successes += source.tools.successes;
  target.tools.failures += source.tools.failures;
  target.deliveryUnknownCount += source.deliveryUnknownCount;
  if (source.deliveryUnknownLastError) {
    target.deliveryUnknownLastError = source.deliveryUnknownLastError;
  }
  target.deliveryOverflowCount += source.deliveryOverflowCount;
  if (source.deliveryOverflowLatestTs !== null) {
    target.deliveryOverflowLatestTs = target.deliveryOverflowLatestTs === null
      ? source.deliveryOverflowLatestTs
      : Math.max(target.deliveryOverflowLatestTs, source.deliveryOverflowLatestTs);
  }
  target.deliveryFailures.push(...source.deliveryFailures);
  target.deliveryFailures.sort((left, right) => left.ts - right.ts);
  while (target.deliveryFailures.length > MAX_TRANSCRIPT_DELIVERY_FAILURES) {
    const removed = target.deliveryFailures.shift();
    target.deliveryOverflowCount += 1;
    if (removed) {
      target.deliveryOverflowLatestTs = target.deliveryOverflowLatestTs === null
        ? removed.ts
        : Math.max(target.deliveryOverflowLatestTs, removed.ts);
    }
  }
  if (source.lastDeliveryError) target.lastDeliveryError = source.lastDeliveryError;
  for (const [name, bucket] of Object.entries(source.byTool)) {
    const key = Object.prototype.hasOwnProperty.call(target.byTool, name) ||
      Object.keys(target.byTool).length < MAX_TRANSCRIPT_TOOL_KEYS
      ? name
      : "__other__";
    const merged = target.byTool[key] ??= emptyToolBucket();
    merged.calls += bucket.calls;
    merged.results += bucket.results;
    merged.successes += bucket.successes;
    merged.failures += bucket.failures;
  }
}
