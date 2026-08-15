import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { scanJsonlFile } from "./jsonl-file-scanner.ts";
import {
  applyTranscriptActivityLine,
  emptyTranscriptActivityCheckpoint,
  pruneTranscriptDeliveryFailures,
} from "./transcript-activity-reducer.ts";
import {
  MAX_TRANSCRIPT_DELIVERY_ERROR_CHARS,
  MAX_TRANSCRIPT_DELIVERY_FAILURES,
  MAX_TRANSCRIPT_TOOL_KEYS,
  TRANSCRIPT_ACTIVITY_INDEX_VERSION,
  type TranscriptActivityAccumulator,
  type TranscriptActivityCheckpoint,
  type TranscriptToolUsageBucket,
} from "./transcript-activity-types.ts";

function checkpointPath(butlerData: string, transcriptPath: string): string {
  const key = createHash("sha256").update(transcriptPath).digest("hex").slice(0, 32);
  return join(butlerData, "metrics", "transcript-activity", `${key}.json`);
}

function readCheckpoint(path: string): TranscriptActivityCheckpoint | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<TranscriptActivityCheckpoint>;
    if (
      value.version !== TRANSCRIPT_ACTIVITY_INDEX_VERSION ||
      typeof value.device !== "number" ||
      typeof value.inode !== "number" ||
      typeof value.byteLength !== "number" ||
      typeof value.mtimeMs !== "number" ||
      typeof value.pendingTailBytes !== "number" ||
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
    return {
      version: TRANSCRIPT_ACTIVITY_INDEX_VERSION,
      device: value.device,
      inode: value.inode,
      byteLength: Math.max(0, Math.trunc(value.byteLength)),
      mtimeMs: value.mtimeMs,
      pendingTailBytes: Math.max(0, Math.trunc(value.pendingTailBytes)),
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
      deliveryFailures: (value.deliveryFailures as unknown[])
        .filter((failure): failure is { ts: number; error: string | null } =>
          Boolean(failure) && typeof failure === "object" &&
          typeof (failure as { ts?: unknown }).ts === "number" &&
          (typeof (failure as { error?: unknown }).error === "string" ||
            (failure as { error?: unknown }).error === null),
        )
        .slice(-MAX_TRANSCRIPT_DELIVERY_FAILURES),
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

function writeCheckpoint(path: string, checkpoint: TranscriptActivityCheckpoint): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(checkpoint)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // A diagnostic checkpoint must never block the primary transcript path.
  }
}

export function readTranscriptActivityIndex(input: {
  butlerData: string;
  transcriptPath: string;
  nowMs?: number;
}): TranscriptActivityAccumulator {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(input.transcriptPath);
  } catch {
    return emptyTranscriptActivityCheckpoint();
  }
  if (!stats.isFile()) return emptyTranscriptActivityCheckpoint();
  const nowMs = input.nowMs ?? Date.now();
  const path = checkpointPath(input.butlerData, input.transcriptPath);
  const previous = readCheckpoint(path);
  const sameFile = Boolean(
    previous && previous.device === Number(stats.dev) && previous.inode === Number(stats.ino),
  );
  const appendBase = sameFile ? previous : null;
  const unchanged = appendBase !== null &&
    appendBase.byteLength === stats.size &&
    appendBase.mtimeMs === Number(stats.mtimeMs);
  if (unchanged && appendBase) {
    pruneTranscriptDeliveryFailures(appendBase, nowMs);
    writeCheckpoint(path, appendBase);
    return appendBase;
  }
  const canAppend = appendBase !== null && stats.size > appendBase.byteLength;
  const next: TranscriptActivityCheckpoint = canAppend && appendBase
    ? {
        ...appendBase,
        byTool: { ...appendBase.byTool },
        tools: { ...appendBase.tools },
        deliveryFailures: [...appendBase.deliveryFailures],
        device: Number(stats.dev),
        inode: Number(stats.ino),
        mtimeMs: Number(stats.mtimeMs),
      }
    : {
        ...emptyTranscriptActivityCheckpoint(),
        device: Number(stats.dev),
        inode: Number(stats.ino),
        mtimeMs: Number(stats.mtimeMs),
      };
  const startOffset = canAppend && appendBase
    ? Math.max(0, appendBase.byteLength - appendBase.pendingTailBytes)
    : 0;
  try {
    const result = scanJsonlFile(input.transcriptPath, {
      startOffset,
      onLine: (line) => applyTranscriptActivityLine(next, line),
      onTrailing: () => {},
    });
    next.byteLength = startOffset + result.bytesRead;
    next.pendingTailBytes = result.trailingBytes;
    next.mtimeMs = result.mtimeMs;
  } catch {
    pruneTranscriptDeliveryFailures(next, nowMs);
    return next;
  }
  pruneTranscriptDeliveryFailures(next, nowMs);
  writeCheckpoint(path, next);
  return next;
}

export function transcriptActivityFilePaths(input: {
  butlerData: string;
  sessionId?: string;
}): string[] {
  const dir = join(input.butlerData, "transcripts");
  if (input.sessionId?.trim()) {
    const safe = input.sessionId.trim().replace(/[^A-Za-z0-9._-]/g, "_");
    return [join(dir, `${safe}.jsonl`)];
  }
  try {
    return readdirSync(dir)
      .filter((entry: string) => entry.endsWith(".jsonl"))
      .map((entry: string) => join(dir, entry));
  } catch {
    return [];
  }
}
