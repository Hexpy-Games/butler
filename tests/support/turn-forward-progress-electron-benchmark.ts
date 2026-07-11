import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { readPromptCacheMetrics } from "../../packages/butler-agent/src/integrations/providers/prompt-cache-metrics.ts";
import { readOperationalMetricEvents } from "../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";
import {
  evaluateSandyForwardProgress,
  type TurnForwardProgressGateResult,
  type TurnForwardProgressMetrics,
} from "./turn-forward-progress-benchmark.ts";

export type LedgerRecordSnapshot = Record<string, string>;

export interface ElectronForwardProgressBenchmark {
  metrics: TurnForwardProgressMetrics;
  gate: TurnForwardProgressGateResult;
  wallMs: number;
  firstMeaningfulMs: number;
  preProviderOverheadMs: number | null;
  interRoundOrchestrationP95Ms: number | null;
  cachedTokens: number;
  uncachedPromptTokens: number;
  cpuRatio: number | null;
  rssBytes: number | null;
  heapUsedBytes: number | null;
  changedLedgerRecords: string[];
  createdLedgerRecords: string[];
}

export function snapshotLedgerRecords(root: string): LedgerRecordSnapshot {
  if (!existsSync(root)) return {};
  return Object.fromEntries(
    listFiles(root)
      .filter((path) => path.endsWith(".md"))
      .map((path) => [
        relative(root, path).replaceAll("\\", "/"),
        createHash("sha256").update(readFileSync(path)).digest("hex"),
      ]),
  );
}

export function collectElectronForwardProgressBenchmark(input: {
  butlerData: string;
  sinceTs: number;
  completedAt: number;
  firstMeaningfulMs: number;
  toolCalls: string[];
  openingDecisions: number;
  noDeltaBroadReadRounds: number;
  contractConflicts: number;
  genericInternalFailures: number;
  liveReplayParity: boolean;
  ledgerBefore: LedgerRecordSnapshot;
  ledgerRoot: string;
  toolCompletedAt: number[];
}): ElectronForwardProgressBenchmark {
  const promptEvents = readPromptCacheMetrics({
    butlerData: input.butlerData,
    sinceTs: input.sinceTs,
  });
  const operationalEvents = readOperationalMetricEvents({
    butlerData: input.butlerData,
    sinceTs: input.sinceTs,
  });
  const modelRequestEvents = operationalEvents
    .filter((event) => event.category === "runtime" && event.name === "model_request_count_by_phase")
    .sort((left, right) => left.ts - right.ts);
  const ledgerAfter = snapshotLedgerRecords(input.ledgerRoot);
  const changedLedgerRecords = changedRecords(input.ledgerBefore, ledgerAfter);
  const createdLedgerRecords = changedLedgerRecords.filter((path) => !(path in input.ledgerBefore));
  const promptTokens = promptEvents.reduce((total, event) => total + event.promptTokens, 0);
  const cachedTokens = promptEvents.reduce((total, event) => total + event.cachedTokens, 0);
  const metrics: TurnForwardProgressMetrics = {
    modelRequests: modelRequestEvents.length,
    toolCalls: input.toolCalls.length,
    promptTokens,
    noDeltaBroadReadRounds: input.noDeltaBroadReadRounds,
    ledgerMutations: changedLedgerRecords.length,
    openingDecisions: input.openingDecisions,
    contractConflicts: input.contractConflicts,
    genericInternalFailures: input.genericInternalFailures,
    liveReplayParity: input.liveReplayParity,
  };
  return {
    metrics,
    gate: evaluateSandyForwardProgress(metrics),
    wallMs: Math.max(0, input.completedAt - input.sinceTs),
    firstMeaningfulMs: input.firstMeaningfulMs,
    preProviderOverheadMs: modelRequestEvents[0]
      ? Math.max(0, modelRequestEvents[0].ts - input.sinceTs)
      : null,
    interRoundOrchestrationP95Ms: interRoundP95(
      input.toolCompletedAt,
      modelRequestEvents.map((event) => event.ts),
    ),
    cachedTokens,
    uncachedPromptTokens: Math.max(0, promptTokens - cachedTokens),
    cpuRatio: latestMetricValue(operationalEvents, "turn_cpu_ratio"),
    rssBytes: latestMetricValue(operationalEvents, "turn_memory_rss"),
    heapUsedBytes: latestMetricValue(operationalEvents, "turn_memory_heap_used"),
    changedLedgerRecords,
    createdLedgerRecords,
  };
}

function changedRecords(
  before: LedgerRecordSnapshot,
  after: LedgerRecordSnapshot,
): string[] {
  return Object.keys(after)
    .filter((path) => sourceRecordPath(path) && before[path] !== after[path])
    .sort();
}

function sourceRecordPath(path: string): boolean {
  return path.startsWith("specs/") || path.startsWith("work/");
}

function interRoundP95(toolCompletedAt: number[], modelRequestAt: number[]): number | null {
  const gaps = toolCompletedAt.flatMap((completedAt) => {
    const nextRequest = modelRequestAt.find((requestedAt) => requestedAt >= completedAt);
    return nextRequest === undefined ? [] : [Math.max(0, nextRequest - completedAt)];
  });
  if (gaps.length === 0) return null;
  const sorted = [...gaps].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? null;
}

function latestMetricValue(
  events: ReturnType<typeof readOperationalMetricEvents>,
  name: string,
): number | null {
  const event = [...events]
    .reverse()
    .find((candidate) => candidate.category === "process" && candidate.name === name);
  return typeof event?.value === "number" ? event.value : null;
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  if (!statSync(root).isDirectory()) return [root];
  return readdirSync(root).flatMap((name) => listFiles(join(root, name)));
}
