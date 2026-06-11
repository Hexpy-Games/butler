import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

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

function getButlerData(): string {
  return process.env.BUTLER_DATA || join(homedir(), ".butler");
}

export function metricsDir(butlerData = getButlerData()): string {
  return join(butlerData, "metrics");
}

export function promptCacheMetricsPath(butlerData = getButlerData()): string {
  return join(metricsDir(butlerData), "prompt-cache-usage.jsonl");
}

export function appendPromptCacheMetric(
  event: PromptCacheMetricEvent,
  options: { butlerData?: string } = {},
): void {
  mkdirSync(metricsDir(options.butlerData), { recursive: true });
  appendFileSync(promptCacheMetricsPath(options.butlerData), `${JSON.stringify(event)}\n`, "utf8");
}

export function readPromptCacheMetrics(options: ReadPromptCacheMetricsOptions = {}): PromptCacheMetricEvent[] {
  const path = promptCacheMetricsPath(options.butlerData);
  if (!existsSync(path)) return [];

  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return [];

  const events: PromptCacheMetricEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as PromptCacheMetricEvent;
      if (
        typeof parsed?.ts === "number" &&
        typeof parsed?.model === "string" &&
        typeof parsed?.scope === "string" &&
        typeof parsed?.promptTokens === "number" &&
        typeof parsed?.cachedTokens === "number"
      ) {
        if (options.sinceTs !== undefined && parsed.ts < options.sinceTs) {
          continue;
        }
        events.push(parsed);
      }
    } catch {
      continue;
    }
  }

  return events;
}

export function summarizePromptCacheMetrics(events: PromptCacheMetricEvent[]): PromptCacheMetricSummary {
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
    summary.totalTokens += typeof event.totalTokens === "number" ? event.totalTokens : 0;
    summary.byScope[event.scope] = (summary.byScope[event.scope] || 0) + 1;
  }

  if (summary.promptTokens > 0) {
    summary.cacheHitRatio = summary.cachedTokens / summary.promptTokens;
  }

  return summary;
}
