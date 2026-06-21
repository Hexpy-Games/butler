import { expect, test } from "bun:test";
import { rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildMetricsStatus,
  renderMetricsStatus,
} from "../../packages/butler-agent/scripts/metrics-status.ts";
import { recordFirstVisibleLatencyMetric } from "../../packages/butler-agent/src/operations/metrics/first-visible-latency.ts";

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
