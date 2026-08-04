import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { PromptUsageAttribution } from "./runtime-contracts.ts";
import { readIncrementalJsonlSnapshot } from "../../operations/metrics/incremental-jsonl-snapshot.ts";

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
    summary.byScope[event.scope] = (summary.byScope[event.scope] || 0) + 1;
  }

  if (summary.promptTokens > 0) {
    summary.cacheHitRatio = summary.cachedTokens / summary.promptTokens;
  }

  return summary;
}
