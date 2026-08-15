import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { createHash } from "crypto";
import { join } from "path";
import type {
  PromptAssemblyContextMetric,
  RuntimeTurnContextMetric,
} from "./context-monitor-telemetry.ts";
import { scanJsonlFile } from "./jsonl-file-scanner.ts";

const INDEX_VERSION = 1;

export interface ContextMetricSummaryReadResult {
  events: number;
  parseErrors: number;
  latestPrompt: PromptAssemblyContextMetric | null;
  latestTurn: RuntimeTurnContextMetric | null;
}

interface ContextMetricSummaryCheckpoint extends ContextMetricSummaryReadResult {
  version: 1;
  device: number;
  inode: number;
  byteLength: number;
  mtimeMs: number;
  pendingTailBytes: number;
  pendingTailParseErrors: number;
}

function checkpointPath(butlerData: string, sourcePath: string, sessionId: string): string {
  const key = createHash("sha256")
    .update(`${sourcePath}\u0000${sessionId}`)
    .digest("hex")
    .slice(0, 32);
  return join(butlerData, "metrics", "context-summary", `${key}.json`);
}

function emptyResult(): ContextMetricSummaryReadResult {
  return {
    events: 0,
    parseErrors: 0,
    latestPrompt: null,
    latestTurn: null,
  };
}

function readCheckpoint(path: string): ContextMetricSummaryCheckpoint | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ContextMetricSummaryCheckpoint>;
    if (
      value.version !== INDEX_VERSION ||
      typeof value.device !== "number" ||
      typeof value.inode !== "number" ||
      typeof value.byteLength !== "number" ||
      typeof value.mtimeMs !== "number" ||
      typeof value.pendingTailBytes !== "number" ||
      (value.pendingTailParseErrors !== undefined && typeof value.pendingTailParseErrors !== "number") ||
      typeof value.events !== "number" ||
      typeof value.parseErrors !== "number"
    ) return null;
    return {
      version: INDEX_VERSION,
      device: value.device,
      inode: value.inode,
      byteLength: Math.max(0, Math.trunc(value.byteLength)),
      mtimeMs: value.mtimeMs,
      pendingTailBytes: Math.max(0, Math.trunc(value.pendingTailBytes)),
      pendingTailParseErrors: typeof value.pendingTailParseErrors === "number"
        ? Math.max(0, Math.trunc(value.pendingTailParseErrors))
        : 0,
      events: Math.max(0, Math.trunc(value.events)),
      parseErrors: Math.max(0, Math.trunc(value.parseErrors)),
      latestPrompt: isPromptMetric(value.latestPrompt) ? value.latestPrompt : null,
      latestTurn: isTurnMetric(value.latestTurn) ? value.latestTurn : null,
    };
  } catch {
    return null;
  }
}

function writeCheckpoint(path: string, checkpoint: ContextMetricSummaryCheckpoint): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(checkpoint)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // A diagnostic checkpoint must never block a context read.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isPromptMetric(value: unknown): value is PromptAssemblyContextMetric {
  return isRecord(value) &&
    value.kind === "prompt_assembly" &&
    typeof value.ts === "number" &&
    typeof value.sessionId === "string" &&
    typeof value.role === "string" &&
    typeof value.totalChars === "number" &&
    Array.isArray(value.sections);
}

function isTurnMetric(value: unknown): value is RuntimeTurnContextMetric {
  return isRecord(value) &&
    value.kind === "runtime_turn" &&
    typeof value.ts === "number" &&
    typeof value.sessionId === "string" &&
    (value.model === null || typeof value.model === "string") &&
    typeof value.totalPromptChars === "number" &&
    typeof value.promptContextChars === "number" &&
    typeof value.recentConversationChars === "number" &&
    typeof value.recallContextChars === "number" &&
    typeof value.inboundMessageChars === "number";
}

function parseMetric(line: string): PromptAssemblyContextMetric | RuntimeTurnContextMetric | null {
  try {
    const value = JSON.parse(line) as unknown;
    return isPromptMetric(value) || isTurnMetric(value) ? value : null;
  } catch {
    return null;
  }
}

function latestByTimestamp<T extends { ts: number }>(current: T | null, candidate: T): T {
  return !current || candidate.ts >= current.ts ? candidate : current;
}

export function readContextMetricSummary(input: {
  butlerData: string;
  contextMetricsPath: string;
  sessionId: string;
}): ContextMetricSummaryReadResult {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(input.contextMetricsPath);
  } catch {
    return emptyResult();
  }
  if (!stats.isFile()) return emptyResult();

  const path = checkpointPath(input.butlerData, input.contextMetricsPath, input.sessionId);
  const previous = readCheckpoint(path);
  const sameFile = Boolean(
    previous && previous.device === Number(stats.dev) && previous.inode === Number(stats.ino),
  );
  const appendBase = sameFile ? previous : null;
  const unchanged = appendBase !== null &&
    appendBase.byteLength === stats.size &&
    appendBase.mtimeMs === Number(stats.mtimeMs);
  if (unchanged && appendBase) {
    return {
      events: appendBase.events,
      parseErrors: appendBase.parseErrors,
      latestPrompt: appendBase.latestPrompt,
      latestTurn: appendBase.latestTurn,
    };
  }

  const canAppend = appendBase !== null && stats.size > appendBase.byteLength;
  const next: ContextMetricSummaryCheckpoint = canAppend && appendBase
    ? {
        ...appendBase,
        device: Number(stats.dev),
        inode: Number(stats.ino),
        mtimeMs: Number(stats.mtimeMs),
      }
    : {
        version: INDEX_VERSION,
        device: Number(stats.dev),
        inode: Number(stats.ino),
        byteLength: 0,
        mtimeMs: Number(stats.mtimeMs),
        pendingTailBytes: 0,
        pendingTailParseErrors: 0,
        ...emptyResult(),
      };
  const startOffset = canAppend && appendBase
    ? Math.max(0, appendBase.byteLength - appendBase.pendingTailBytes)
    : 0;
  if (canAppend && appendBase && appendBase.pendingTailParseErrors > 0) {
    next.parseErrors = Math.max(0, next.parseErrors - appendBase.pendingTailParseErrors);
  }
  next.pendingTailParseErrors = 0;

  const apply = (line: string): void => {
    if (!line.trim()) return;
    const metric = parseMetric(line);
    if (!metric) {
      next.parseErrors += 1;
      return;
    }
    if (metric.sessionId !== input.sessionId) return;
    next.events += 1;
    if (metric.kind === "prompt_assembly") {
      next.latestPrompt = latestByTimestamp(next.latestPrompt, metric);
    } else {
      next.latestTurn = latestByTimestamp(next.latestTurn, metric);
    }
  };

  let scanResult: ReturnType<typeof scanJsonlFile>;
  try {
    scanResult = scanJsonlFile(input.contextMetricsPath, {
      startOffset,
      onLine: apply,
      // A no-newline tail is deliberately held out until its newline arrives;
      // this prevents counting it twice when the writer completes the record.
      onTrailing: (line) => {
        if (line.trim() && !parseMetric(line)) {
          next.parseErrors += 1;
          next.pendingTailParseErrors += 1;
        }
      },
      onOversized: ({ complete }) => {
        if (complete) next.parseErrors += 1;
      },
    });
  } catch {
    return appendBase ? {
      events: appendBase.events,
      parseErrors: appendBase.parseErrors,
      latestPrompt: appendBase.latestPrompt,
      latestTurn: appendBase.latestTurn,
    } : emptyResult();
  }
  next.byteLength = startOffset + scanResult.bytesRead;
  next.pendingTailBytes = scanResult.trailingBytes;
  next.mtimeMs = scanResult.mtimeMs;
  writeCheckpoint(path, next);
  return {
    events: next.events,
    parseErrors: next.parseErrors,
    latestPrompt: next.latestPrompt,
    latestTurn: next.latestTurn,
  };
}
