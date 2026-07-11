import { recordOperationalMetric } from "../../../../operations/metrics/operational-metrics.ts";

export interface TurnResourceSnapshot {
  cpuUserMicros: number;
  cpuSystemMicros: number;
}

export function turnResourceSnapshot(): TurnResourceSnapshot {
  const cpu = process.cpuUsage();
  return {
    cpuUserMicros: cpu.user,
    cpuSystemMicros: cpu.system,
  };
}

export function recordTurnResourceMetrics(input: {
  butlerData: string;
  status: "ok" | "error";
  role: string;
  runtime: string;
  model: string;
  durationMs: number;
  start: TurnResourceSnapshot;
}): void {
  const end = process.cpuUsage();
  const memory = process.memoryUsage();
  const cpuMicros = Math.max(
    0,
    end.user - input.start.cpuUserMicros + end.system - input.start.cpuSystemMicros,
  );
  const dimensions = {
    role: input.role,
    runtime: input.runtime,
    model: input.model,
  };
  for (const metric of [
    {
      name: "turn_cpu_ratio",
      value: input.durationMs > 0 ? cpuMicros / (input.durationMs * 1_000) : 0,
      unit: "ratio",
    },
    { name: "turn_memory_rss", value: memory.rss, unit: "bytes" },
    { name: "turn_memory_heap_used", value: memory.heapUsed, unit: "bytes" },
  ]) {
    recordOperationalMetric({
      category: "process",
      name: metric.name,
      status: input.status,
      value: metric.value,
      unit: metric.unit,
      dimensions,
    }, { butlerData: input.butlerData });
  }
}
