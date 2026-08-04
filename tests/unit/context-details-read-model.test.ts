import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRuntimeTurnContextMetric } from "../../packages/butler-agent/src/operations/metrics/context-monitor.ts";
import {
  appendPromptCacheMetric,
  readPromptCacheMetrics,
} from "../../packages/butler-agent/src/integrations/providers/prompt-cache-metrics.ts";
import { latestLivePromptUsage } from "../../packages/butler-agent/src/gateways/app/domain/sessions/context-details-read-model.ts";

function writeMetrics(
  butlerData: string,
  events: Array<Record<string, unknown>>,
): void {
  const metricsDir = join(butlerData, "metrics");
  mkdirSync(metricsDir, { recursive: true });
  writeFileSync(
    join(metricsDir, "prompt-cache-usage.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
}

function withTempData(run: (butlerData: string) => void): void {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-context-read-model-"));
  try {
    run(butlerData);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
}

test("exact Turn provider telemetry wins over newer legacy metrics", () => {
  withTempData((butlerData) => {
    writeMetrics(butlerData, [
      {
        ts: 1_000,
        model: "openai/gpt-5.6-sol",
        scope: "btcc-guided:butler/app-general",
        turnId: "turn-current",
        promptTokens: 64_000,
        cachedTokens: 0,
      },
      {
        ts: 2_000,
        model: "openai/gpt-5.6-sol",
        scope: "btcc-guided:butler/app-general",
        promptTokens: 9_000,
        cachedTokens: 0,
      },
    ]);

    expect(
      latestLivePromptUsage({
        butlerData,
        runtimeSessionId: "butler/app-general",
        turnId: "turn-current",
        latestTurnStartedAt: "1970-01-01T00:00:00.500Z",
      }),
    ).toMatchObject({
      promptTokens: 64_000,
      source: "provider_prompt_usage",
    });
  });
});

test("legacy telemetry requires the exact guided scope and current Turn start", () => {
  withTempData((butlerData) => {
    writeMetrics(butlerData, [
      {
        ts: 900,
        model: "openai/gpt-5.6-sol",
        scope: "btcc-guided:butler/app-general",
        promptTokens: 8_000,
        cachedTokens: 0,
      },
      {
        ts: 1_100,
        model: "openai/gpt-5.6-sol",
        scope: "btcc-guided:butler/app-other",
        promptTokens: 12_000,
        cachedTokens: 0,
      },
      {
        ts: 1_200,
        model: "openai/gpt-5.6-sol",
        scope: "btcc-guided:butler/app-general",
        turnId: "turn-previous",
        promptTokens: 16_000,
        cachedTokens: 0,
      },
      {
        ts: 1_300,
        model: "openai/gpt-5.6-sol",
        scope: "btcc-guided:butler/app-general",
        promptTokens: 10_000,
        cachedTokens: 0,
      },
    ]);

    expect(
      latestLivePromptUsage({
        butlerData,
        runtimeSessionId: "butler/app-general",
        turnId: "turn-current",
        latestTurnStartedAt: "1970-01-01T00:00:01.000Z",
      }),
    ).toMatchObject({
      promptTokens: 10_000,
      source: "provider_prompt_usage",
    });
  });
});

test("legacy telemetry is ignored when the latest Turn start is unavailable", () => {
  withTempData((butlerData) => {
    writeMetrics(butlerData, [
      {
        ts: 1_300,
        model: "openai/gpt-5.6-sol",
        scope: "btcc-guided:butler/app-general",
        promptTokens: 10_000,
        cachedTokens: 0,
      },
    ]);

    expect(
      latestLivePromptUsage({
        butlerData,
        runtimeSessionId: "butler/app-general",
        turnId: "turn-current",
      }),
    ).toBeNull();
  });
});

test("legacy attribution accepts only an omitted turnId and exact scope", () => {
  withTempData((butlerData) => {
    writeMetrics(butlerData, [
      {
        ts: 1_100,
        model: "openai/gpt-5.6-sol",
        scope: "btcc-guided:butler/app-general",
        turnId: "",
        promptTokens: 11_000,
        cachedTokens: 0,
      },
      {
        ts: 1_200,
        model: "openai/gpt-5.6-sol",
        scope: "btcc-guided:butler/app-general",
        turnId: "  ",
        promptTokens: 12_000,
        cachedTokens: 0,
      },
      {
        ts: 1_300,
        model: "openai/gpt-5.6-sol",
        scope: "btcc-guided:butler/app-general",
        turnId: null,
        promptTokens: 13_000,
        cachedTokens: 0,
      },
      {
        ts: 1_400,
        model: "openai/gpt-5.6-sol",
        scope: "btcc-guided:butler/app-general",
        turnId: 42,
        promptTokens: 14_000,
        cachedTokens: 0,
      },
      {
        ts: 1_500,
        model: "openai/gpt-5.6-sol",
        scope: "btcc-guided:butler/app-other",
        promptTokens: 15_000,
        cachedTokens: 0,
      },
      {
        ts: 1_600,
        model: "openai/gpt-5.6-sol",
        scope: "btcc-guided:butler/app-general",
        promptTokens: 16_000,
        cachedTokens: 0,
      },
    ]);

    expect(
      latestLivePromptUsage({
        butlerData,
        runtimeSessionId: "butler/app-general",
        turnId: "turn-current",
        latestTurnStartedAt: 1_000,
      }),
    ).toMatchObject({ promptTokens: 16_000 });
  });
});

test("context monitor fallback rejects stale samples and accepts the current Turn", () => {
  withTempData((butlerData) => {
    const metric = {
      butlerData,
      sessionId: "butler/app-general",
      model: "openai/gpt-5.6-sol",
      totalPromptChars: 4_000,
      promptContextChars: 3_000,
      recentConversationChars: 500,
      recallContextChars: 500,
      inboundMessageChars: 100,
    };
    appendRuntimeTurnContextMetric({ ...metric, now: 900 });
    expect(
      latestLivePromptUsage({
        butlerData,
        runtimeSessionId: "butler/app-general",
        turnId: "turn-current",
        latestTurnStartedAt: 1_000,
        currentModelRef: "openai/gpt-5.6-sol",
      }),
    ).toBeNull();

    appendRuntimeTurnContextMetric({ ...metric, now: 1_100 });
    expect(
      latestLivePromptUsage({
        butlerData,
        runtimeSessionId: "butler/app-general",
        turnId: "turn-current",
        latestTurnStartedAt: 1_000,
        currentModelRef: "openai/gpt-5.6-sol",
      }),
    ).toMatchObject({ source: "context_monitor" });
  });
});

test("prompt metric snapshots stay isolated and advance on append", () => {
  withTempData((butlerData) => {
    appendPromptCacheMetric(
      {
        ts: 1_000,
        model: "openai/gpt-5.6-sol",
        scope: "btcc-guided:butler/app-general",
        promptTokens: 10,
        cachedTokens: 0,
      },
      { butlerData },
    );
    expect(readPromptCacheMetrics({ butlerData })).toHaveLength(1);
    expect(readPromptCacheMetrics({ butlerData })).toHaveLength(1);
    appendPromptCacheMetric(
      {
        ts: 1_100,
        model: "openai/gpt-5.6-sol",
        scope: "btcc-guided:butler/app-general",
        promptTokens: 20,
        cachedTokens: 0,
      },
      { butlerData },
    );
    expect(
      readPromptCacheMetrics({ butlerData }).map((event) => event.promptTokens),
    ).toEqual([10, 20]);

    const otherData = mkdtempSync(
      join(tmpdir(), "butler-context-read-model-other-"),
    );
    try {
      appendPromptCacheMetric(
        {
          ts: 2_000,
          model: "openai/gpt-5.6-sol",
          scope: "btcc-guided:butler/app-general",
          promptTokens: 30,
          cachedTokens: 0,
        },
        { butlerData: otherData },
      );
      expect(
        readPromptCacheMetrics({ butlerData: otherData }).map(
          (event) => event.promptTokens,
        ),
      ).toEqual([30]);
      expect(
        readPromptCacheMetrics({ butlerData }).map(
          (event) => event.promptTokens,
        ),
      ).toEqual([10, 20]);
    } finally {
      rmSync(otherData, { recursive: true, force: true });
    }
  });
});
