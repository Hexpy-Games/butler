import type {
  PackagedAggregateSample,
  PackagedMetricName,
  PackagedProcessSample,
} from "./packaged-performance-snapshot.ts";

/**
 * Aggregates process-level observations without making an incomplete metric
 * look complete. The coverage map is consumed by the physical-memory gate.
 */
export function aggregateProcessSamples(samples: PackagedProcessSample[]): PackagedAggregateSample {
  const unsupportedReasons: Partial<Record<PackagedMetricName, string>> = {};
  const metricCoverage: Partial<Record<PackagedMetricName, number>> = {};
  const sum = (name: PackagedMetricName): number | null => {
    const values = samples.map((sample) => sample[name] as number | null);
    const present = values.filter((value): value is number => value !== null);
    metricCoverage[name] = present.length;
    if (present.length === 0) {
      const reason = samples.map((sample) => sample.unsupportedReasons[name]).find(Boolean);
      if (reason) unsupportedReasons[name] = reason;
      return null;
    }
    if (present.length !== values.length) {
      unsupportedReasons[name] = `${values.length - present.length} process role(s) did not expose ${name}`;
    }
    return present.reduce((total, value) => total + value, 0);
  };
  const physicalFootprintBytes = sum("physicalFootprintBytes");
  const privateResidentBytes = sum("privateResidentBytes");
  const rssBytes = sum("rssBytes");
  const gateMemorySource = physicalFootprintBytes !== null
    ? "physical_footprint"
    : privateResidentBytes !== null
      ? "private_resident"
      : rssBytes !== null
        ? "rss"
        : null;
  const gateMemoryBytes = gateMemorySource === "physical_footprint"
    ? physicalFootprintBytes
    : gateMemorySource === "private_resident"
      ? privateResidentBytes
      : rssBytes;
  return {
    physicalFootprintBytes,
    privateResidentBytes,
    compressedBytes: sum("compressedBytes"),
    swapBytes: sum("swapBytes"),
    rssBytes,
    virtualSizeBytes: sum("virtualSizeBytes"),
    nativeHeapBytes: sum("nativeHeapBytes"),
    externalHeapBytes: sum("externalHeapBytes"),
    openHandles: sum("openHandles"),
    connections: sum("connections"),
    gateMemoryBytes,
    gateMemorySource,
    processCount: samples.length,
    metricCoverage,
    unsupportedReasons,
  };
}
