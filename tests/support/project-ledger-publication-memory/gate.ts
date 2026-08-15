import {
  PROJECT_LEDGER_DEFAULT_STEADY_CYCLES,
  PROJECT_LEDGER_MEMORY_BUDGET_BYTES,
  PROJECT_LEDGER_MAX_STEADY_CYCLES,
  PROJECT_LEDGER_MIN_STEADY_CYCLES,
  PROJECT_LEDGER_POST_WARMUP_GROWTH_RATIO,
  type GateStatus,
  type MemorySource,
  type ProjectLedgerPublicationMemoryCycle,
  type ProjectLedgerPublicationMemoryExternalSample,
  type ProjectLedgerPublicationMemoryGate,
} from "./contracts.ts";

export function evaluateProjectLedgerPublicationMemoryGate(input: {
  platform: NodeJS.Platform;
  cycles: readonly ProjectLedgerPublicationMemoryCycle[];
  runFailureCodes?: readonly string[];
  budgetBytes?: number;
  growthRatio?: number;
  requiredSteadyCycles?: number;
}): ProjectLedgerPublicationMemoryGate {
  const budgetBytes = boundedBudget(input.budgetBytes);
  const growthRatio = boundedGrowthRatio(input.growthRatio);
  const requiredSteadyCycles = boundedSteadyCycles(input.requiredSteadyCycles);
  const memorySource = memorySourceForPlatform(input.platform);
  const steady = input.cycles.filter((cycle) => cycle.phase === "steady");
  const failureCodes = [...new Set(input.runFailureCodes ?? [])];
  if (failureCodes.length > 0) {
    return gateResult("fail", budgetBytes, memorySource, steady, null, null, null, null, failureCodes);
  }
  if (!memorySource) {
    return gateResult("unavailable", budgetBytes, null, steady, null, null, null, null,
      ["platform_memory_source_unavailable"]);
  }
  if (steady.length !== requiredSteadyCycles || steady.some((cycle) => !cycle.completed)) {
    return gateResult("unavailable", budgetBytes, memorySource, steady, null, null, null, null,
      ["steady_cycles_incomplete"]);
  }
  if (input.platform === "win32" && steady.some((cycle) =>
    cycle.external.privateCommittedBytes === null)) {
    return gateResult("unavailable", budgetBytes, memorySource, steady, null, null, null, null,
      ["windows_private_committed_unavailable"]);
  }
  if (steady.some((cycle) => cycle.external.source !== memorySource)) {
    return gateResult("unavailable", budgetBytes, memorySource, steady, null, null, null, null,
      ["memory_source_mismatch"]);
  }
  const values = steady.map((cycle) => memoryValue(cycle.external, memorySource));
  if (values.some((value) => value === null)) {
    return gateResult("unavailable", budgetBytes, memorySource, steady, null, null, null, null,
      ["memory_source_unavailable"]);
  }
  const numericValues = values as number[];
  const baselineBytes = median(numericValues.slice(0, 3));
  const peakBytes = Math.max(...numericValues);
  const finalBytes = median(numericValues.slice(-3));
  if (baselineBytes <= 0) {
    return gateResult("unavailable", budgetBytes, memorySource, steady, baselineBytes, peakBytes,
      finalBytes, null, ["memory_baseline_unavailable"]);
  }
  const peakToBaselineRatio = finalBytes / baselineBytes;
  const failures: string[] = [];
  const privateCommittedValues = input.platform === "win32"
    ? steady.map((cycle) => cycle.external.privateCommittedBytes)
    : [];
  const privateCommittedPeakBytes = privateCommittedValues.length > 0
    ? Math.max(...privateCommittedValues as number[])
    : null;
  if (peakBytes > budgetBytes) failures.push("memory_budget_exceeded");
  if (privateCommittedPeakBytes !== null && privateCommittedPeakBytes > budgetBytes) {
    failures.push("private_committed_budget_exceeded");
  }
  if (peakToBaselineRatio > growthRatio) failures.push("post_warmup_growth_exceeded");
  if (isMonotonicNonDecreasing(numericValues)) {
    failures.push("memory_monotonic_growth");
  }
  return gateResult(
    failures.length === 0 ? "pass" : "fail",
    budgetBytes,
    memorySource,
    steady,
    baselineBytes,
    peakBytes,
    finalBytes,
    peakToBaselineRatio,
    failures,
    privateCommittedPeakBytes,
  );
}

export function memorySourceForPlatform(platform: NodeJS.Platform): MemorySource | null {
  if (platform === "darwin") return "physical_footprint";
  if (platform === "linux") return "private_resident";
  if (platform === "win32") return "working_set";
  return null;
}

export function boundedSteadyCycles(value: number | undefined): number {
  if (!Number.isFinite(value) || (value ?? 0) < PROJECT_LEDGER_MIN_STEADY_CYCLES) {
    return PROJECT_LEDGER_DEFAULT_STEADY_CYCLES;
  }
  return Math.min(Math.trunc(value!), PROJECT_LEDGER_MAX_STEADY_CYCLES);
}

function memoryValue(sample: ProjectLedgerPublicationMemoryExternalSample, source: MemorySource): number | null {
  if (source === "physical_footprint") return sample.physicalFootprintBytes;
  if (source === "private_resident") return sample.privateResidentBytes;
  return sample.workingSetBytes;
}

function gateResult(
  status: GateStatus,
  budgetBytes: number,
  memorySource: MemorySource | null,
  steady: readonly ProjectLedgerPublicationMemoryCycle[],
  baselineBytes: number | null,
  peakBytes: number | null,
  finalBytes: number | null,
  peakToBaselineRatio: number | null,
  failureCodes: readonly string[],
  privateCommittedPeakBytes: number | null = null,
): ProjectLedgerPublicationMemoryGate {
  return {
    status,
    budgetBytes,
    memorySource,
    steadyCycleCount: steady.length,
    baselineBytes,
    peakBytes,
    finalBytes,
    peakToBaselineRatio,
    privateCommittedPeakBytes,
    failureCodes: [...new Set(failureCodes)],
  };
}

function boundedBudget(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.trunc(value!)
    : PROJECT_LEDGER_MEMORY_BUDGET_BYTES;
}

function boundedGrowthRatio(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 1
    ? value!
    : PROJECT_LEDGER_POST_WARMUP_GROWTH_RATIO;
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
