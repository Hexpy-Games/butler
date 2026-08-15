import { expect, test } from "bun:test";
import { appendFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildMetricsStatus,
  renderMetricsStatus,
} from "../../packages/butler-agent/scripts/metrics-status.ts";
import { recordFirstVisibleLatencyMetric } from "../../packages/butler-agent/src/operations/metrics/first-visible-latency.ts";
import { operationalMetricsPath, readOperationalMetricSummary, recordOperationalMetric } from "../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";

function tempRoot(): string {
  return join(tmpdir(), `butler-metrics-status-reporting-${Date.now()}-${Math.random()}`);
}

test("metrics status reports first visible latency without raw text", () => {
  const butlerData = tempRoot();

  try {
    recordFirstVisibleLatencyMetric({
      butlerData,
      now: 1,
      durationMs: 44,
      signal: "first_progress",
      transport: "app",
      role: "butler",
      source: "SECRET_PROMPT_TEXT",
    });
    recordFirstVisibleLatencyMetric({
      butlerData,
      now: 2,
      durationMs: 88,
      signal: "runtime_preparation",
      role: "butler",
    });

    const status = buildMetricsStatus({ butlerData });
    const rendered = renderMetricsStatus(status);

    expect(status.firstVisibleLatency).toMatchObject({
      events: 2,
      p50Ms: 44,
      p95Ms: 88,
      bySignal: {
        first_progress: 1,
        runtime_preparation: 1,
      },
      privacy: {
        rawTextStored: false,
      },
    });
    expect(rendered).toContain("first visible latency: events=2, p50=44ms, p95=88ms");
    expect(JSON.stringify(status)).not.toContain("SECRET_PROMPT_TEXT");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("operational metric summaries stream large logs and tolerate a corrupt tail", () => {
  const butlerData = tempRoot();
  try {
    for (let index = 0; index < 5_000; index += 1) {
      recordOperationalMetric({
        ts: index,
        category: "runtime",
        name: "turn",
        status: index % 11 === 0 ? "error" : "ok",
        durationMs: index,
      }, { butlerData });
    }
    appendFileSync(operationalMetricsPath(butlerData), "{corrupt trailing metric\n", "utf8");

    const summary = readOperationalMetricSummary({ butlerData });

    expect(summary).toMatchObject({
      totalEvents: 5_000,
      parseErrors: 1,
      byCategory: {
        runtime: {
          events: 5_000,
          errors: 455,
          durationMs: {
            count: 5_000,
            min: 0,
            max: 4_999,
            average: 2_499.5,
          },
        },
      },
    });
    expect(summary.byName["runtime:turn"]?.durationMs.p50).not.toBeNull();
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
