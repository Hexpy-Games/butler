import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export interface MetricFileRetentionResult {
  path: string;
  scanned: number;
  kept: number;
  deleted: number;
  parseErrors: number;
}

export interface ContextMetricRetentionResult {
  files: MetricFileRetentionResult[];
  totals: {
    scanned: number;
    kept: number;
    deleted: number;
    parseErrors: number;
    rawTextStored: false;
  };
}

function defaultMetricPaths(butlerData: string): string[] {
  return [
    join(butlerData, "metrics", "context-monitor.jsonl"),
    join(butlerData, "metrics", "context-compaction.jsonl"),
    join(butlerData, "metrics", "tool-output-prune.jsonl"),
    join(butlerData, "metrics", "operational-events.jsonl"),
  ];
}

function eventTimestamp(parsed: Record<string, unknown>): number | null {
  return typeof parsed.ts === "number" && Number.isFinite(parsed.ts) ? parsed.ts : null;
}

export function pruneMetricJsonlByAge(input: {
  path: string;
  nowMs: number;
  maxAgeMs: number;
}): MetricFileRetentionResult {
  if (!existsSync(input.path)) {
    return {
      path: input.path,
      scanned: 0,
      kept: 0,
      deleted: 0,
      parseErrors: 0,
    };
  }

  let scanned = 0;
  let kept = 0;
  let deleted = 0;
  let parseErrors = 0;
  const keepLines: string[] = [];
  for (const line of readFileSync(input.path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    scanned += 1;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const ts = eventTimestamp(parsed);
      if (ts === null) {
        parseErrors += 1;
        continue;
      }
      if (input.nowMs - ts > input.maxAgeMs) {
        deleted += 1;
        continue;
      }
      kept += 1;
      keepLines.push(JSON.stringify({
        ...parsed,
        rawTextStored: false,
      }));
    } catch {
      parseErrors += 1;
    }
  }

  mkdirSync(dirname(input.path), { recursive: true });
  writeFileSync(input.path, keepLines.length > 0 ? `${keepLines.join("\n")}\n` : "", "utf8");

  return {
    path: input.path,
    scanned,
    kept,
    deleted,
    parseErrors,
  };
}

export function pruneContextMetricFiles(input: {
  butlerData: string;
  nowMs?: number;
  maxAgeMs?: number;
  paths?: string[];
}): ContextMetricRetentionResult {
  const nowMs = input.nowMs ?? Date.now();
  const maxAgeMs = Math.max(0, input.maxAgeMs ?? 90 * 24 * 60 * 60 * 1000);
  const files = (input.paths ?? defaultMetricPaths(input.butlerData)).map((path) =>
    pruneMetricJsonlByAge({
      path,
      nowMs,
      maxAgeMs,
    }),
  );
  return {
    files,
    totals: {
      scanned: files.reduce((sum, file) => sum + file.scanned, 0),
      kept: files.reduce((sum, file) => sum + file.kept, 0),
      deleted: files.reduce((sum, file) => sum + file.deleted, 0),
      parseErrors: files.reduce((sum, file) => sum + file.parseErrors, 0),
      rawTextStored: false,
    },
  };
}
