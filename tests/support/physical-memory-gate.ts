import type {
  PackagedPerformanceSnapshot,
  PackagedAggregateSample,
  PackagedProcessTarget,
} from "./packaged-performance-snapshot.ts";

export type PhysicalMemoryGateMetric =
  | "memory_plateau"
  | "memory_monotonic_growth"
  | "resource_plateau"
  | "resource_monotonic_growth"
  | "embed_idle_reclamation";

export interface EmbedIdleReclamation {
  baselineBytes: number | null;
  loadedBytes: number | null;
  afterIdleBytes: number | null;
  /** Maximum allowed multiple of the unloaded baseline after idle. */
  maxBaselineMultiplier?: number;
}

export interface PhysicalMemoryGateResult {
  ok: boolean;
  failures: string[];
  metrics: {
    steadyCycleCount: number;
    firstThreeMedianBytes: number | null;
    finalThreeMedianBytes: number | null;
    finalVsFirstRatio: number | null;
    memoryValues: Array<number | null>;
    resourceValues: Array<number | null>;
    memorySource: string | null;
    embedBaselineBytes: number | null;
    embedLoadedBytes: number | null;
    embedAfterIdleBytes: number | null;
  };
  unsupportedReasons: string[];
}

export interface PhysicalMemoryGateInput {
  cycles: PackagedPerformanceSnapshot[];
  idleReclamation?: EmbedIdleReclamation;
  warmupCycles?: number;
  plateauRatio?: number;
  /** Initial role/label contract. Embed may be supervised onto a new PID. */
  requiredProcessTargets?: PackagedProcessTarget[];
}

export function evaluatePhysicalMemoryGate(
  input: PhysicalMemoryGateInput,
): PhysicalMemoryGateResult {
  const inferredWarmupCycles = input.cycles.findIndex((cycle) => cycle.cycle?.phase !== "warmup");
  const warmupCycles = Math.max(
    0,
    Math.trunc(input.warmupCycles ?? (inferredWarmupCycles < 0 ? input.cycles.length : inferredWarmupCycles)),
  );
  const plateauRatio = Number.isFinite(input.plateauRatio) && (input.plateauRatio ?? 0) > 1
    ? input.plateauRatio!
    : 1.1;
  const steady = input.cycles.slice(warmupCycles);
  const memorySeries = selectMemorySeries(steady);
  const memoryValues = memorySeries.values;
  const resourceValues = steady.map((cycle) => totalResourceCount(cycle.aggregate));
  const failures: string[] = [];
  const unsupportedReasons = [...new Set(
    steady.flatMap((cycle) => Object.values(cycle.aggregate?.unsupportedReasons ?? {})),
  )];

  validateCycleSources(steady, failures, memorySeries.source);
  validateProcessContinuity(steady, failures, input.requiredProcessTargets);

  let firstThreeMedianBytes: number | null = null;
  let finalThreeMedianBytes: number | null = null;
  let finalVsFirstRatio: number | null = null;
  if (steady.length < 6) {
    failures.push("physical memory gate requires at least six steady-state cycles");
  } else if (memoryValues.some((value) => value === null)) {
    failures.push("physical memory gate has unsupported memory samples in the steady-state series");
  } else {
    const numericValues = memoryValues as number[];
    firstThreeMedianBytes = median(numericValues.slice(0, 3));
    finalThreeMedianBytes = median(numericValues.slice(-3));
    finalVsFirstRatio = firstThreeMedianBytes > 0
      ? finalThreeMedianBytes / firstThreeMedianBytes
      : null;
    if (finalVsFirstRatio === null || finalVsFirstRatio > plateauRatio) {
      failures.push(`physical memory final median exceeds ${((plateauRatio - 1) * 100).toFixed(0)}% plateau allowance`);
    }
    if (isMonotonicNonDecreasing(numericValues)) {
      failures.push("physical memory grows monotonically across steady-state cycles");
    }
  }

  const memorySource = memorySeries.source;
  if (memorySeries.metricName) {
    const metricName = memorySeries.metricName;
    const incomplete = steady.some((cycle) => {
      const aggregate = cycle.aggregate;
      if (!aggregate) return true;
      if (aggregate.processCount === undefined || aggregate.metricCoverage === undefined) {
        return true;
      }
      return aggregate.metricCoverage[metricName] !== aggregate.processCount;
    });
    if (incomplete) {
      failures.push(`${memorySource ?? metricName} samples are incomplete across declared process roles`);
    }
  }

  const numericResources = resourceValues.filter((value): value is number => value !== null);
  if (numericResources.length !== resourceValues.length) {
    failures.push("resource counters are unsupported for one or more steady-state cycles");
  } else if (isMonotonicNonDecreasing(numericResources)) {
    failures.push("open handles/connections grow monotonically across steady-state cycles");
  }

  const idle = input.idleReclamation;
  if (!idle) {
    failures.push("embed idle reclamation evidence is missing");
  } else {
    const multiplier = Number.isFinite(idle.maxBaselineMultiplier) && (idle.maxBaselineMultiplier ?? 0) > 1
      ? idle.maxBaselineMultiplier!
      : 1.5;
    if (idle.baselineBytes === null || idle.loadedBytes === null || idle.afterIdleBytes === null) {
      failures.push("embed idle reclamation has unsupported samples");
    } else {
      if (idle.loadedBytes <= idle.baselineBytes) {
        failures.push("embed loaded sample does not exceed the unloaded baseline class");
      }
      if (idle.afterIdleBytes > idle.baselineBytes * multiplier) {
        failures.push("embed remains above the unloaded baseline class after idle reclamation");
      }
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    metrics: {
      steadyCycleCount: steady.length,
      firstThreeMedianBytes,
      finalThreeMedianBytes,
      finalVsFirstRatio,
      memoryValues,
      resourceValues,
      memorySource,
      embedBaselineBytes: idle?.baselineBytes ?? null,
      embedLoadedBytes: idle?.loadedBytes ?? null,
      embedAfterIdleBytes: idle?.afterIdleBytes ?? null,
    },
    unsupportedReasons,
  };
}

function selectMemorySeries(cycles: PackagedPerformanceSnapshot[]): {
  values: Array<number | null>;
  source: "physical_footprint" | "private_resident" | "rss" | null;
  metricName: "physicalFootprintBytes" | "privateResidentBytes" | "rssBytes" | null;
} {
  const platform = cycles[0]?.platform;
  if (platform === "darwin") {
    return {
      values: cycles.map((cycle) => cycle.aggregate?.physicalFootprintBytes ?? null),
      source: "physical_footprint",
      metricName: "physicalFootprintBytes",
    };
  }
  if (platform === "linux") {
    return {
      values: cycles.map((cycle) => cycle.aggregate?.privateResidentBytes ?? null),
      source: "private_resident",
      metricName: "privateResidentBytes",
    };
  }
  const source = cycles.find((cycle) => cycle.aggregate?.gateMemorySource)?.aggregate?.gateMemorySource ?? null;
  const metricName = source === "physical_footprint"
    ? "physicalFootprintBytes"
    : source === "private_resident"
      ? "privateResidentBytes"
      : source === "rss"
        ? "rssBytes"
        : null;
  return {
    values: cycles.map((cycle) => {
      const aggregate = cycle.aggregate;
      if (!aggregate || aggregate.gateMemorySource !== source) return null;
      return aggregate.gateMemoryBytes;
    }),
    source,
    metricName,
  };
}

function validateCycleSources(
  cycles: PackagedPerformanceSnapshot[],
  failures: string[],
  selectedSource: string | null,
): void {
  const platform = cycles[0]?.platform;
  if (platform && cycles.some((cycle) => cycle.platform !== platform)) {
    failures.push("physical memory cycles use mixed platform sources");
  }
  const sources = cycles.map((cycle) => cycle.aggregate?.gateMemorySource ?? null);
  if (sources.some((source) => source !== sources[0])) {
    failures.push("physical memory cycles use mixed gate memory sources");
  }
  if (selectedSource && sources.some((source) => source !== selectedSource)) {
    failures.push(`physical memory cycles do not consistently provide ${selectedSource}`);
  }
}

function validateProcessContinuity(
  cycles: PackagedPerformanceSnapshot[],
  failures: string[],
  requiredTargets?: PackagedProcessTarget[],
): void {
  const firstObserved = cycles.find((cycle) => cycle.processes.length > 0)?.processes ?? [];
  const expected = requiredTargets ?? firstObserved;
  if (expected.length === 0 || cycles.every((cycle) => cycle.processes.length === 0)) return;
  const expectedKeys = expected.map(processIdentity);
  if (new Set(expectedKeys).size !== expectedKeys.length) {
    failures.push("required process role-label attribution is not unique");
    return;
  }
  const baselineByKey = new Map(expected.map((target) => [processIdentity(target), target]));
  for (const [index, cycle] of cycles.entries()) {
    const actualKeys = cycle.processes.map(processIdentity);
    if (new Set(actualKeys).size !== actualKeys.length ||
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key) => !baselineByKey.has(key))) {
      failures.push(`process role-label continuity is incomplete at cycle ${index}`);
      continue;
    }
    for (const sample of cycle.processes) {
      const baseline = baselineByKey.get(processIdentity(sample));
      if (!baseline || sample.role === "embed") continue;
      if (sample.pid !== baseline.pid) {
        failures.push(`process PID continuity changed for ${sample.role}:${sample.label ?? ""}`);
      }
    }
  }
}

function processIdentity(target: PackagedProcessTarget): string {
  return `${target.role}:${target.label ?? ""}`;
}

function totalResourceCount(aggregate: PackagedAggregateSample | undefined): number | null {
  if (!aggregate || aggregate.openHandles === null || aggregate.connections === null) return null;
  return aggregate.openHandles + aggregate.connections;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function isMonotonicNonDecreasing(values: number[]): boolean {
  return values.length > 1 &&
    values.some((value, index) => index > 0 && value > values[index - 1]!) &&
    values.every((value, index) => index === 0 || value >= values[index - 1]!);
}
