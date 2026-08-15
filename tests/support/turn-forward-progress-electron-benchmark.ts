import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { visitPromptCacheMetrics } from "../../packages/butler-agent/src/integrations/providers/prompt-cache-metrics.ts";
import { readOperationalMetricEvents } from "../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";
import {
  evaluateSandyForwardProgress,
  type TurnForwardProgressGateResult,
  type TurnForwardProgressMetrics,
} from "./turn-forward-progress-benchmark.ts";
import {
  measurePackagedProcesses,
  requiredProcessRolesMeasured,
  type DatabaseFileSample,
  type PackagedCoreProcessRole,
  type PackagedPerformanceSnapshot,
  type PackagedProcessMeasurement,
} from "./packaged-performance-snapshot.ts";

export type LedgerRecordSnapshot = Record<string, string>;

export interface PackagedTransportCounters {
  sessionViewRequests: number;
  liveStreamConnections: number;
  liveEvents: number;
  heartbeatEvents: number;
  reconcileRequests: number;
}

export interface DatabaseGrowthMeasurement {
  relativePath: string;
  beforeBytes: number;
  afterBytes: number;
  growthBytes: number;
}

export interface ElectronForwardProgressBenchmark {
  schema: "butler.packaged-performance-measurement.v1";
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
  processSnapshots: {
    before: PackagedPerformanceSnapshot["processes"];
    after: PackagedPerformanceSnapshot["processes"];
    agentOperational: {
      cpuRatio: number | null;
      rssBytes: number | null;
      heapUsedBytes: number | null;
    };
  };
  processMeasurements: PackagedProcessMeasurement[];
  databaseGrowth: {
    files: DatabaseGrowthMeasurement[];
    beforeBytes: number;
    afterBytes: number;
    growthBytes: number;
  };
  transport: PackagedTransportCounters;
  measurementCompleteness: {
    complete: boolean;
    processRoles: Record<PackagedCoreProcessRole, boolean>;
    databaseFiles: boolean;
    transportCounters: boolean;
  };
  changedLedgerRecords: string[];
  createdLedgerRecords: string[];
}

export interface ElectronForwardProgressBenchmarkInput {
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
  beforeSnapshot: PackagedPerformanceSnapshot;
  afterSnapshot: PackagedPerformanceSnapshot;
  transportCounters: PackagedTransportCounters;
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

export function collectElectronForwardProgressBenchmark(
  input: ElectronForwardProgressBenchmarkInput,
): ElectronForwardProgressBenchmark {
  let promptTokens = 0;
  let cachedTokens = 0;
  visitPromptCacheMetrics({
    butlerData: input.butlerData,
    sinceTs: input.sinceTs,
    onEvent: (event) => {
      promptTokens += event.promptTokens;
      cachedTokens += event.cachedTokens;
    },
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
  const cpuRatio = latestMetricValue(operationalEvents, "turn_cpu_ratio");
  const rssBytes = latestMetricValue(operationalEvents, "turn_memory_rss");
  const heapUsedBytes = latestMetricValue(
    operationalEvents,
    "turn_memory_heap_used",
  );
  const databaseGrowth = measureDatabaseGrowth(
    input.beforeSnapshot.databases,
    input.afterSnapshot.databases,
  );
  const processMeasurements = measurePackagedProcesses(
    input.beforeSnapshot,
    input.afterSnapshot,
  );
  const processRoles = requiredProcessRolesMeasured(processMeasurements);
  const databaseFiles = databaseGrowth.files.length > 0;
  const transportCounters = completeTransportCounters(input.transportCounters);
  return {
    schema: "butler.packaged-performance-measurement.v1",
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
    cpuRatio,
    rssBytes,
    heapUsedBytes,
    processSnapshots: {
      before: input.beforeSnapshot.processes,
      after: input.afterSnapshot.processes,
      agentOperational: { cpuRatio, rssBytes, heapUsedBytes },
    },
    processMeasurements,
    databaseGrowth,
    transport: input.transportCounters,
    measurementCompleteness: {
      complete:
        Object.values(processRoles).every(Boolean) &&
        databaseFiles &&
        transportCounters,
      processRoles,
      databaseFiles,
      transportCounters,
    },
    changedLedgerRecords,
    createdLedgerRecords,
  };
}

function completeTransportCounters(counters: PackagedTransportCounters): boolean {
  return Object.values(counters).every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  );
}

function measureDatabaseGrowth(
  before: DatabaseFileSample[],
  after: DatabaseFileSample[],
): ElectronForwardProgressBenchmark["databaseGrowth"] {
  const beforeByPath = new Map(
    before.map((sample) => [sample.relativePath, sample.sizeBytes]),
  );
  const afterByPath = new Map(
    after.map((sample) => [sample.relativePath, sample.sizeBytes]),
  );
  const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])]
    .sort();
  const files = paths.map((relativePath) => {
    const beforeBytes = beforeByPath.get(relativePath) ?? 0;
    const afterBytes = afterByPath.get(relativePath) ?? 0;
    return {
      relativePath,
      beforeBytes,
      afterBytes,
      growthBytes: afterBytes - beforeBytes,
    };
  });
  const beforeBytes = files.reduce((total, file) => total + file.beforeBytes, 0);
  const afterBytes = files.reduce((total, file) => total + file.afterBytes, 0);
  return { files, beforeBytes, afterBytes, growthBytes: afterBytes - beforeBytes };
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
