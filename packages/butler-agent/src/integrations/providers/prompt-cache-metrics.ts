import { appendFileSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { PromptUsageAttribution } from "./runtime-contracts.ts";
import {
  readIncrementalJsonlSnapshot,
} from "../../operations/metrics/incremental-jsonl-snapshot.ts";
import { scanJsonlFile } from "../../operations/metrics/jsonl-file-scanner.ts";

export type PromptCacheRetention = "in_memory" | "24h";

export interface PromptCacheMetricEvent {
  ts: number;
  model: string;
  scope: string;
  turnId?: string;
  phase?: string;
  roundIndex?: number;
  reasoningEffort?: string;
  promptTokens: number;
  cachedTokens: number;
  cacheWriteTokens?: number;
  totalTokens?: number | null;
  promptCacheKey?: string;
  promptCacheRetention?: PromptCacheRetention;
  budgetState?: {
    status: "ok" | "warning" | "exhausted";
    requestCount: number;
    maxRequests: number;
    promptTokens?: number;
    cachedTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    maxPromptTokens?: number;
    maxOutputTokens?: number;
    maxTotalTokens?: number;
    stopReason?: string;
  };
  promptSections?: Array<{
    id: string;
    chars: number;
    estimatedTokens: number;
  }>;
}

export interface PromptCacheMetricSummary {
  requestCount: number;
  promptTokens: number;
  cachedTokens: number;
  totalTokens: number;
  cacheHitRatio: number;
  byScope: Record<string, number>;
}

interface ReadPromptCacheMetricsOptions {
  sinceTs?: number;
  butlerData?: string;
}

export interface PromptCacheMetricReadSummary {
  summary: PromptCacheMetricSummary;
  parseErrors: number;
}

const MAX_PROMPT_CACHE_SCOPE_KEYS = 512;

function getButlerData(): string {
  return process.env.BUTLER_DATA || join(homedir(), ".butler");
}

export function metricsDir(butlerData = getButlerData()): string {
  return join(butlerData, "metrics");
}

export function promptCacheMetricsPath(butlerData = getButlerData()): string {
  return join(metricsDir(butlerData), "prompt-cache-usage.jsonl");
}

/**
 * Cheap source identity for hot context diagnostics. The full metric stream
 * remains the authority for a cache miss; polling only needs size/mtime to
 * know when a newly appended provider sample requires re-reading it.
 */
export function promptCacheMetricsRevision(
  butlerData = getButlerData(),
): string {
  const path = promptCacheMetricsPath(butlerData);
  try {
    const stat = statSync(path);
    return `${path}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return `${path}:missing`;
  }
}

export function appendPromptCacheMetric(
  event: PromptCacheMetricEvent,
  options: { butlerData?: string } = {},
): void {
  mkdirSync(metricsDir(options.butlerData), { recursive: true });
  appendFileSync(
    promptCacheMetricsPath(options.butlerData),
    `${JSON.stringify(event)}\n`,
    "utf8",
  );
}

export function appendPromptUsageMetric(input: {
  model: string;
  scope: string;
  promptTokens: number | null;
  cachedTokens: number;
  totalTokens: number | null;
  cacheWriteTokens?: number | null;
  promptCacheKey?: string;
  promptCacheRetention?: PromptCacheRetention;
  butlerData?: string;
  usageAttribution?: PromptUsageAttribution;
}): void {
  if (
    !Number.isFinite(input.promptTokens) ||
    input.promptTokens === null ||
    input.promptTokens < 0 ||
    !Number.isFinite(input.cachedTokens) ||
    (input.totalTokens !== null && !Number.isFinite(input.totalTokens))
  ) {
    return;
  }

  appendPromptCacheMetric(
    {
      ts: Date.now(),
      model: input.model,
      scope: input.scope,
      ...(input.usageAttribution?.turnId !== undefined
        ? { turnId: input.usageAttribution.turnId }
        : {}),
      ...(input.usageAttribution?.phase !== undefined
        ? { phase: input.usageAttribution.phase }
        : {}),
      ...(input.usageAttribution?.roundIndex !== undefined
        ? { roundIndex: input.usageAttribution.roundIndex }
        : {}),
      ...(input.usageAttribution?.reasoningEffort !== undefined
        ? { reasoningEffort: input.usageAttribution.reasoningEffort }
        : {}),
      promptTokens: Math.max(0, input.promptTokens),
      cachedTokens: Math.max(0, input.cachedTokens),
      ...(input.cacheWriteTokens !== undefined &&
      input.cacheWriteTokens !== null
        ? { cacheWriteTokens: Math.max(0, input.cacheWriteTokens) }
        : {}),
      totalTokens: input.totalTokens,
      ...(input.promptCacheKey !== undefined
        ? { promptCacheKey: input.promptCacheKey }
        : {}),
      ...(input.promptCacheRetention !== undefined
        ? { promptCacheRetention: input.promptCacheRetention }
        : {}),
      budgetState:
        input.usageAttribution?.getBudgetState?.() ??
        input.usageAttribution?.budgetState,
      promptSections: input.usageAttribution?.promptSections,
    },
    { butlerData: input.butlerData },
  );
}

export function readPromptCacheMetrics(
  options: ReadPromptCacheMetricsOptions = {},
): PromptCacheMetricEvent[] {
  const path = promptCacheMetricsPath(options.butlerData);
  const cached = readIncrementalJsonlSnapshot(path, parsePromptMetricLine);
  return options.sinceTs === undefined
    ? cached.values
    : cached.values.filter((event) => event.ts >= options.sinceTs!);
}

/**
 * Stream prompt-cache rows into a caller-owned aggregate. Unlike the legacy
 * list reader this never retains one object per historical request, so usage
 * status remains bounded as the telemetry log grows.
 */
export function visitPromptCacheMetrics(input: {
  butlerData?: string;
  sinceTs?: number;
  onEvent: (event: PromptCacheMetricEvent) => void;
}): { parseErrors: number } {
  const path = promptCacheMetricsPath(input.butlerData);
  try {
    let parseErrors = 0;
    scanJsonlFile(path, {
      onLine: (line) => {
        const event = parsePromptMetricLine(line);
        if (!event) {
          if (line.trim()) parseErrors += 1;
          return;
        }
        if (input.sinceTs === undefined || event.ts >= input.sinceTs) {
          input.onEvent(event);
        }
      },
      onTrailing: (line) => {
        const event = parsePromptMetricLine(line);
        if (!event) {
          if (line.trim()) parseErrors += 1;
          return;
        }
        if (input.sinceTs === undefined || event.ts >= input.sinceTs) {
          input.onEvent(event);
        }
      },
    });
    return { parseErrors };
  } catch {
    return { parseErrors: 0 };
  }
}

/**
 * Build the bounded prompt-cache projection directly from the JSONL source.
 * Callers that only need totals must use this path instead of
 * `readPromptCacheMetrics`, which is retained solely for compatibility with
 * diagnostic/test readers that explicitly need a bounded recent list.
 */
export function summarizePromptCacheMetricsFromDisk(
  options: ReadPromptCacheMetricsOptions = {},
): PromptCacheMetricReadSummary {
  const summary: PromptCacheMetricSummary = {
    requestCount: 0,
    promptTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    cacheHitRatio: 0,
    byScope: {},
  };
  const result = visitPromptCacheMetrics({
    butlerData: options.butlerData,
    sinceTs: options.sinceTs,
    onEvent: (event) => {
      summary.requestCount += 1;
      summary.promptTokens += event.promptTokens;
      summary.cachedTokens += event.cachedTokens;
      summary.totalTokens +=
        typeof event.totalTokens === "number" ? event.totalTokens : 0;
      const scope = Object.prototype.hasOwnProperty.call(summary.byScope, event.scope) ||
        Object.keys(summary.byScope).length < MAX_PROMPT_CACHE_SCOPE_KEYS
        ? event.scope
        : "__other__";
      summary.byScope[scope] = (summary.byScope[scope] || 0) + 1;
    },
  });
  if (summary.promptTokens > 0) {
    summary.cacheHitRatio = summary.cachedTokens / summary.promptTokens;
  }
  return { summary, parseErrors: result.parseErrors };
}

function parsePromptMetricLine(line: string): PromptCacheMetricEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as PromptCacheMetricEvent;
    return typeof parsed?.ts === "number" &&
      typeof parsed?.model === "string" &&
      typeof parsed?.scope === "string" &&
      typeof parsed?.promptTokens === "number" &&
      typeof parsed?.cachedTokens === "number"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function summarizePromptCacheMetrics(
  events: PromptCacheMetricEvent[],
): PromptCacheMetricSummary {
  const summary: PromptCacheMetricSummary = {
    requestCount: 0,
    promptTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    cacheHitRatio: 0,
    byScope: {},
  };

  for (const event of events) {
    summary.requestCount += 1;
    summary.promptTokens += event.promptTokens;
    summary.cachedTokens += event.cachedTokens;
    summary.totalTokens +=
      typeof event.totalTokens === "number" ? event.totalTokens : 0;
    const scope = Object.prototype.hasOwnProperty.call(summary.byScope, event.scope) ||
      Object.keys(summary.byScope).length < MAX_PROMPT_CACHE_SCOPE_KEYS
      ? event.scope
      : "__other__";
    summary.byScope[scope] = (summary.byScope[scope] || 0) + 1;
  }

  if (summary.promptTokens > 0) {
    summary.cacheHitRatio = summary.cachedTokens / summary.promptTokens;
  }

  return summary;
}
