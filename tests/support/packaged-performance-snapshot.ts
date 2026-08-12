import {
  readProcessSample,
  readSystemMemorySample,
} from "./packaged-performance-samplers.ts";
import { aggregateProcessSamples } from "./packaged-performance-aggregation.ts";
import { databaseFileSamples } from "./packaged-performance-database.ts";

export type PackagedProcessRole =
  | "electron_main"
  | "electron_renderer"
  | "electron_gpu"
  | "electron_utility"
  | "app_gateway"
  | "agent_runtime"
  | "embed"
  | "owned_sidecar";

export type PackagedCoreProcessRole = "electron_main" | "electron_renderer" | "agent_runtime";

export const PACKAGED_CORE_PROCESS_ROLES: PackagedCoreProcessRole[] = [
  "electron_main",
  "electron_renderer",
  "agent_runtime",
];

export const PACKAGED_PHYSICAL_PROCESS_ROLES: PackagedProcessRole[] = [
  "electron_main",
  "electron_renderer",
  "electron_gpu",
  "electron_utility",
  "app_gateway",
  "agent_runtime",
  "embed",
  "owned_sidecar",
];

export type PackagedMetricName =
  | "physicalFootprintBytes"
  | "privateResidentBytes"
  | "compressedBytes"
  | "swapBytes"
  | "rssBytes"
  | "virtualSizeBytes"
  | "nativeHeapBytes"
  | "externalHeapBytes"
  | "openHandles"
  | "connections";

export interface PackagedProcessTarget {
  role: PackagedProcessRole;
  pid: number;
  label?: string;
}

export interface PackagedProcessSample extends PackagedProcessTarget {
  cpuPercent: number | null;
  cpuTimeMs: number | null;
  rssBytes: number | null;
  virtualSizeBytes: number | null;
  physicalFootprintBytes: number | null;
  privateResidentBytes: number | null;
  compressedBytes: number | null;
  swapBytes: number | null;
  nativeHeapBytes: number | null;
  externalHeapBytes: number | null;
  openHandles: number | null;
  connections: number | null;
  unsupportedReasons: Partial<Record<PackagedMetricName, string>>;
}

export interface PackagedAggregateSample {
  physicalFootprintBytes: number | null;
  privateResidentBytes: number | null;
  compressedBytes: number | null;
  swapBytes: number | null;
  rssBytes: number | null;
  virtualSizeBytes: number | null;
  nativeHeapBytes: number | null;
  externalHeapBytes: number | null;
  openHandles: number | null;
  connections: number | null;
  gateMemoryBytes: number | null;
  gateMemorySource: "physical_footprint" | "private_resident" | "rss" | null;
  processCount: number;
  metricCoverage: Partial<Record<PackagedMetricName, number>>;
  unsupportedReasons: Partial<Record<PackagedMetricName, string>>;
}

export interface PackagedSystemMemorySample {
  compressedBytes: number | null;
  swapBytes: number | null;
  unsupportedReasons: Partial<Record<"compressedBytes" | "swapBytes", string>>;
}

export interface PackagedPerformanceCycle {
  index: number;
  phase: "warmup" | "steady" | "idle";
  label?: string;
}

export interface PackagedPerformanceSnapshot {
  capturedAt: string;
  platform: NodeJS.Platform;
  processes: PackagedProcessSample[];
  aggregate: PackagedAggregateSample;
  system: PackagedSystemMemorySample;
  databases: DatabaseFileSample[];
  cycle?: PackagedPerformanceCycle;
}

export interface PackagedProcessMeasurement extends PackagedProcessTarget {
  beforeCpuTimeMs: number;
  afterCpuTimeMs: number;
  cpuRatio: number;
  beforeRssBytes: number;
  afterRssBytes: number;
  rssGrowthBytes: number;
  physicalFootprintGrowthBytes: number | null;
  privateResidentGrowthBytes: number | null;
  swapGrowthBytes: number | null;
  handlesGrowth: number | null;
  connectionsGrowth: number | null;
}

export interface DatabaseFileSample {
  relativePath: string;
  sizeBytes: number;
}

export interface PackagedPerformanceSampler {
  platform?: NodeJS.Platform;
  run?: (command: string, args: string[]) => string;
  readFile?: (path: string) => string;
  listDirectory?: (path: string) => string[];
  runtimeMemory?: () => { external: number } | null;
}

export function capturePackagedPerformanceSnapshot(input: {
  butlerData: string;
  processTargets: PackagedProcessTarget[];
  capturedAt?: Date;
  cycle?: PackagedPerformanceCycle;
  sampler?: PackagedPerformanceSampler;
}): PackagedPerformanceSnapshot {
  const sampler = input.sampler ?? {};
  const platform = sampler.platform ?? process.platform;
  const samplesByPid = new Map<number, PackagedProcessSample>();
  const processes = input.processTargets.map((target) => {
    const existing = samplesByPid.get(target.pid);
    if (existing) return { ...existing, ...target };
    const sample = readProcessSample(target, platform, sampler);
    samplesByPid.set(target.pid, sample);
    return sample;
  });
  return {
    capturedAt: (input.capturedAt ?? new Date()).toISOString(),
    platform,
    processes,
    aggregate: aggregateProcessSamples(processes),
    system: readSystemMemorySample(platform, sampler),
    databases: databaseFileSamples(input.butlerData),
    ...(input.cycle ? { cycle: input.cycle } : {}),
  };
}

export function measurePackagedProcesses(
  before: PackagedPerformanceSnapshot,
  after: PackagedPerformanceSnapshot,
): PackagedProcessMeasurement[] {
  const elapsedMs = Date.parse(after.capturedAt) - Date.parse(before.capturedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return [];
  const afterByIdentity = new Map(
    after.processes.map((sample) => [processIdentity(sample), sample]),
  );
  return before.processes.flatMap((sample) => {
    const next = afterByIdentity.get(processIdentity(sample));
    if (
      !next ||
      sample.cpuTimeMs === null ||
      sample.rssBytes === null ||
      next.cpuTimeMs === null ||
      next.rssBytes === null
    ) {
      return [];
    }
    const cpuTimeMs = Math.max(0, next.cpuTimeMs - sample.cpuTimeMs);
    return [{
      role: sample.role,
      pid: sample.pid,
      ...(sample.label || next.label ? { label: next.label ?? sample.label } : {}),
      beforeCpuTimeMs: sample.cpuTimeMs,
      afterCpuTimeMs: next.cpuTimeMs,
      cpuRatio: cpuTimeMs / elapsedMs,
      beforeRssBytes: sample.rssBytes,
      afterRssBytes: next.rssBytes,
      rssGrowthBytes: next.rssBytes - sample.rssBytes,
      physicalFootprintGrowthBytes: nullableDelta(sample.physicalFootprintBytes, next.physicalFootprintBytes),
      privateResidentGrowthBytes: nullableDelta(sample.privateResidentBytes, next.privateResidentBytes),
      swapGrowthBytes: nullableDelta(sample.swapBytes, next.swapBytes),
      handlesGrowth: nullableDelta(sample.openHandles, next.openHandles),
      connectionsGrowth: nullableDelta(sample.connections, next.connections),
    }];
  });
}

export function requiredProcessRolesMeasured(
  measurements: PackagedProcessMeasurement[],
): Record<PackagedCoreProcessRole, boolean> {
  return Object.fromEntries(
    PACKAGED_CORE_PROCESS_ROLES.map((role) => [
      role,
      measurements.some((sample) => sample.role === role),
    ]),
  ) as Record<PackagedCoreProcessRole, boolean>;
}

function processIdentity(sample: PackagedProcessTarget): string {
  return `${sample.role}:${sample.pid}:${sample.label ?? ""}`;
}

function nullableDelta(before: number | null, after: number | null): number | null {
  return before === null || after === null ? null : after - before;
}
