import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { scanJsonlFile } from "./jsonl-file-scanner.ts";
import {
  applyTranscriptActivityLine,
  pruneTranscriptDeliveryFailures,
} from "./transcript-activity-reducer.ts";
import {
  MAX_TRANSCRIPT_DELIVERY_ERROR_CHARS,
  MAX_TRANSCRIPT_DELIVERY_FAILURES,
  MAX_TRANSCRIPT_TOOL_KEYS,
  TRANSCRIPT_ACTIVITY_INDEX_VERSION,
  type TranscriptActivityAggregateCheckpoint,
  type TranscriptToolUsageBucket,
} from "./transcript-activity-types.ts";

const AGGREGATE_FILE_NAME = "aggregate.json";
const AGGREGATE_LOCK_NAME = "aggregate.lock";
const AGGREGATE_DELTA_FILE_NAME = "aggregate-deltas.jsonl";

export function aggregatePath(butlerData: string): string {
  return join(butlerData, "metrics", "transcript-activity", AGGREGATE_FILE_NAME);
}

export function aggregateLockPath(butlerData: string): string {
  return join(butlerData, "metrics", "transcript-activity", AGGREGATE_LOCK_NAME);
}

export function isAggregateLockHeld(butlerData: string): boolean {
  try {
    return statSync(aggregateLockPath(butlerData)).isDirectory();
  } catch {
    return false;
  }
}

function aggregateDeltaPath(butlerData: string): string {
  return join(butlerData, "metrics", "transcript-activity", AGGREGATE_DELTA_FILE_NAME);
}

export function hasAggregateDeltas(butlerData: string): boolean {
  try {
    return statSync(aggregateDeltaPath(butlerData)).isFile();
  } catch {
    return false;
  }
}

export function readAggregate(path: string): TranscriptActivityAggregateCheckpoint | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<TranscriptActivityAggregateCheckpoint>;
    if (
      value.version !== TRANSCRIPT_ACTIVITY_INDEX_VERSION ||
      typeof value.updatedAtMs !== "number" ||
      typeof value.deliveryFailed !== "number" ||
      !value.tools || typeof value.tools !== "object" ||
      !value.byTool || typeof value.byTool !== "object" ||
      !Array.isArray(value.deliveryFailures)
    ) return null;
    const byTool: Record<string, TranscriptToolUsageBucket> = {};
    for (const [name, bucket] of Object.entries(value.byTool as Record<string, unknown>)) {
      if (Object.keys(byTool).length >= MAX_TRANSCRIPT_TOOL_KEYS + 1) break;
      if (!bucket || typeof bucket !== "object") continue;
      const candidate = bucket as Partial<TranscriptToolUsageBucket>;
      if ([candidate.calls, candidate.results, candidate.successes, candidate.failures]
        .every((count) => typeof count === "number")) {
        byTool[name] = {
          calls: Math.max(0, Math.trunc(candidate.calls!)),
          results: Math.max(0, Math.trunc(candidate.results!)),
          successes: Math.max(0, Math.trunc(candidate.successes!)),
          failures: Math.max(0, Math.trunc(candidate.failures!)),
        };
      }
    }
    const tools = value.tools as Partial<TranscriptToolUsageBucket>;
    if (![tools.calls, tools.results, tools.successes, tools.failures]
      .every((count) => typeof count === "number")) return null;
    const deliveryFailures = (value.deliveryFailures as unknown[])
      .filter((failure): failure is { ts: number; error: string | null } =>
        Boolean(failure) && typeof failure === "object" &&
        typeof (failure as { ts?: unknown }).ts === "number" &&
        (typeof (failure as { error?: unknown }).error === "string" ||
          (failure as { error?: unknown }).error === null),
      )
      .slice(-MAX_TRANSCRIPT_DELIVERY_FAILURES);
    return {
      version: TRANSCRIPT_ACTIVITY_INDEX_VERSION,
      updatedAtMs: value.updatedAtMs,
      tools: {
        calls: Math.max(0, Math.trunc(tools.calls!)),
        results: Math.max(0, Math.trunc(tools.results!)),
        successes: Math.max(0, Math.trunc(tools.successes!)),
        failures: Math.max(0, Math.trunc(tools.failures!)),
      },
      byTool,
      deliveryFailed: Math.max(0, Math.trunc(value.deliveryFailed)),
      lastDeliveryError: typeof value.lastDeliveryError === "string"
        ? value.lastDeliveryError.slice(0, MAX_TRANSCRIPT_DELIVERY_ERROR_CHARS)
        : null,
      deliveryFailures,
      deliveryUnknownCount: typeof value.deliveryUnknownCount === "number"
        ? Math.max(0, Math.trunc(value.deliveryUnknownCount))
        : 0,
      deliveryUnknownLastError: typeof value.deliveryUnknownLastError === "string"
        ? value.deliveryUnknownLastError.slice(0, MAX_TRANSCRIPT_DELIVERY_ERROR_CHARS)
        : null,
      deliveryOverflowCount: typeof value.deliveryOverflowCount === "number"
        ? Math.max(0, Math.trunc(value.deliveryOverflowCount))
        : 0,
      deliveryOverflowLatestTs: typeof value.deliveryOverflowLatestTs === "number"
        ? value.deliveryOverflowLatestTs
        : null,
    };
  } catch {
    return null;
  }
}

export function writeCheckpoint(path: string, checkpoint: object): boolean {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(checkpoint)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
    return true;
  } catch {
    return false;
  }
}

export function withAggregateLock<T>(butlerData: string, action: () => T): T | null {
  const lockPath = aggregateLockPath(butlerData);
  mkdirSync(join(lockPath, ".."), { recursive: true });
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      mkdirSync(lockPath);
      try {
        return action();
      } finally {
        rmSync(lockPath, { recursive: true, force: true });
      }
    } catch {
      try {
        const ageMs = Date.now() - statSync(lockPath).mtimeMs;
        if (ageMs > 5_000) rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // The owner may have released the lock between stat and cleanup.
      }
      Atomics.wait(waitBuffer, 0, 0, Math.min(5, 1 + Math.trunc(attempt / 10)));
    }
  }
  return null;
}

export function appendAggregateDelta(input: {
  butlerData: string;
  kind: string;
  timestamp?: string;
  payload?: { name?: unknown; ok?: unknown; error?: unknown };
}): void {
  const path = aggregateDeltaPath(input.butlerData);
  mkdirSync(join(path, ".."), { recursive: true });
  const payload: {
    name: string | null;
    ok?: boolean;
    error: string | null;
  } = {
    name: typeof input.payload?.name === "string" ? input.payload.name.slice(0, 512) : null,
    error: typeof input.payload?.error === "string"
      ? input.payload.error.slice(0, MAX_TRANSCRIPT_DELIVERY_ERROR_CHARS)
      : null,
  };
  if (typeof input.payload?.ok === "boolean") payload.ok = input.payload.ok;
  appendFileSync(path, `${JSON.stringify({
    kind: input.kind,
    timestamp: input.timestamp ?? null,
    payload,
  })}\n`, { encoding: "utf8", mode: 0o600 });
}

export function drainAggregateDeltas(
  aggregate: TranscriptActivityAggregateCheckpoint,
  butlerData: string,
): { path: string; removeOnCommit: boolean } | null {
  const path = aggregateDeltaPath(butlerData);
  const drainPath = `${path}.${process.pid}.${Date.now()}.drain`;
  try {
    renameSync(path, drainPath);
  } catch {
    return null;
  }
  try {
    scanJsonlFile(drainPath, {
      onLine: (line) => applyTranscriptActivityLine(aggregate, line),
      onTrailing: (line) => applyTranscriptActivityLine(aggregate, line),
    });
    return { path: drainPath, removeOnCommit: true };
  } catch {
    return { path: drainPath, removeOnCommit: false };
  }
}

export function rotateAggregateDeltas(butlerData: string): string | null {
  const path = aggregateDeltaPath(butlerData);
  const drainPath = `${path}.${process.pid}.${Date.now()}.rebuild`;
  try {
    renameSync(path, drainPath);
    return drainPath;
  } catch {
    return null;
  }
}

export function reconcilePendingAggregateDeltas(
  butlerData: string,
): TranscriptActivityAggregateCheckpoint | null {
  const path = aggregatePath(butlerData);
  return withAggregateLock(butlerData, () => {
    const aggregate = readAggregate(path);
    if (!aggregate) return null;
    const pending = drainAggregateDeltas(aggregate, butlerData);
    if (!pending) return aggregate;
    pruneTranscriptDeliveryFailures(aggregate, Date.now());
    aggregate.updatedAtMs = Date.now();
    const wrote = writeCheckpoint(path, aggregate);
    if (wrote && pending.removeOnCommit) rmSync(pending.path, { force: true });
    return aggregate;
  });
}
