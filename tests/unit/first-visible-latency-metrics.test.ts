import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  FIRST_VISIBLE_LATENCY_METRIC_NAME,
  TURN_PREPARATION_STEP_METRIC_NAME,
  readFirstVisibleLatencySummary,
  recordFirstVisibleLatencyMetric,
  recordTurnPreparationStepMetric,
} from "../../packages/butler-agent/src/operations/metrics/first-visible-latency.ts";
import {
  operationalMetricsPath,
  readOperationalMetricEvents,
} from "../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";

function tempRoot(): string {
  return join(tmpdir(), `butler-first-visible-metrics-${Date.now()}-${Math.random()}`);
}

test("first visible latency metrics record safe signal durations", () => {
  const butlerData = tempRoot();

  try {
    recordFirstVisibleLatencyMetric({
      butlerData,
      now: 1,
      durationMs: 125.4,
      signal: "first_progress",
      transport: "app",
      role: "butler",
      runtime: "native-tool-loop",
      model: "openai/auto:codex-latest",
      source: "gateway-actor",
    });
    recordFirstVisibleLatencyMetric({
      butlerData,
      now: 2,
      durationMs: 20,
      signal: "runtime_preparation",
      source: "SECRET_PROMPT_TEXT",
    });

    const rawMetrics = readFileSync(operationalMetricsPath(butlerData), "utf8");
    const summary = readFirstVisibleLatencySummary({ butlerData });

    expect(summary).toMatchObject({
      events: 2,
      averageMs: 72.7,
      p50Ms: 20,
      p95Ms: 125.4,
      bySignal: {
        first_progress: 1,
        runtime_preparation: 1,
      },
      privacy: {
        rawTextStored: false,
      },
    });
    expect(summary.latest?.name).toBe(FIRST_VISIBLE_LATENCY_METRIC_NAME);
    expect(rawMetrics).not.toContain("SECRET_PROMPT_TEXT");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("turn preparation step metrics use bounded operational schema", () => {
  const butlerData = tempRoot();

  try {
    recordTurnPreparationStepMetric({
      butlerData,
      now: 10,
      step: "automatic_recall",
      durationMs: -3,
      status: "skipped",
      role: "butler",
      runtime: "native-tool-loop",
      model: "openai/auto:codex-latest",
      skippedReason: "disabled",
    });

    const [event] = readOperationalMetricEvents({ butlerData });

    expect(event).toMatchObject({
      category: "runtime",
      name: TURN_PREPARATION_STEP_METRIC_NAME,
      status: "skipped",
      durationMs: 0,
      unit: "ms",
      rawTextStored: false,
      dimensions: {
        step: "automatic_recall",
        skippedReason: "disabled",
      },
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
