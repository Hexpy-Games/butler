import { existsSync } from "fs";
import { scanJsonlFile } from "./jsonl-file-scanner.ts";
import {
  emptyTranscriptActivitySummary,
  ensureTranscriptActivityAggregateStatus,
  transcriptActivityFilePaths,
} from "./transcript-activity-index.ts";
import type { ToolUsageBucket, UsageMonitorSummary } from "./usage-monitor.ts";

const MAX_TOOL_USAGE_KEYS = 512;

function emptyBucket(): ToolUsageBucket {
  return { calls: 0, results: 0, successes: 0, failures: 0 };
}

function bucketFor(byTool: Record<string, ToolUsageBucket>, name: string): ToolUsageBucket {
  const key = Object.prototype.hasOwnProperty.call(byTool, name) ||
    Object.keys(byTool).length < MAX_TOOL_USAGE_KEYS
    ? name
    : "__other__";
  byTool[key] ??= emptyBucket();
  return byTool[key];
}

function eventInWindow(timestamp: unknown, sinceTs: number | null): boolean {
  if (sinceTs === null) return true;
  if (typeof timestamp !== "string") return false;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && parsed >= sinceTs;
}

/** Owns canonical transcript tool-event reduction for usage-monitor reads. */
export function summarizeToolUsage(input: {
  butlerData: string;
  sessionId?: string;
  sinceTs: number | null;
  aggregate?: ReturnType<typeof ensureTranscriptActivityAggregateStatus>;
}): UsageMonitorSummary["tools"] {
  if (input.sinceTs === null && !input.sessionId?.trim()) {
    const indexed = input.aggregate?.summary ?? emptyTranscriptActivitySummary();
    return { ...indexed.tools, byTool: indexed.byTool };
  }
  if (input.sinceTs !== null && !input.sessionId?.trim()) {
    return { ...emptyTranscriptActivitySummary().tools, byTool: {} };
  }
  const summary: UsageMonitorSummary["tools"] = { ...emptyBucket(), byTool: {} };
  for (const path of transcriptActivityFilePaths(input)) {
    if (!existsSync(path)) continue;
    const visit = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const event = JSON.parse(trimmed) as {
          kind?: unknown;
          timestamp?: unknown;
          payload?: { name?: unknown; ok?: unknown };
        };
        if (!eventInWindow(event.timestamp, input.sinceTs)) return;
        const name = typeof event.payload?.name === "string" && event.payload.name.trim()
          ? event.payload.name.trim()
          : null;
        if (!name) return;
        const bucket = bucketFor(summary.byTool, name);
        if (event.kind === "tool_call") {
          summary.calls += 1;
          bucket.calls += 1;
        } else if (event.kind === "tool_result") {
          summary.results += 1;
          bucket.results += 1;
          if (event.payload?.ok === false) {
            summary.failures += 1;
            bucket.failures += 1;
          } else {
            summary.successes += 1;
            bucket.successes += 1;
          }
        }
      } catch {
        // A malformed trailing diagnostic record is not live usage.
      }
    };
    try {
      scanJsonlFile(path, { onLine: visit, onTrailing: visit });
    } catch {
      // Transcript rotation/removal during a status call is benign.
    }
  }
  return summary;
}
