import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  FIRST_MODEL_DELTA_LATENCY_METRIC_NAME,
  FIRST_TOOL_EVENT_LATENCY_METRIC_NAME,
  MODEL_REQUEST_BY_PHASE_METRIC_NAME,
  MODEL_RESPONSE_USAGE_BY_PHASE_METRIC_NAME,
  PHASE_BUDGET_EXHAUSTED_METRIC_NAME,
  createTurnLatencyMetricRecorder,
  summarizeTurnLatencyBaseline,
} from "../../packages/butler-agent/src/operations/metrics/turn-latency.ts";
import {
  operationalMetricsPath,
  readOperationalMetricEvents,
  type OperationalMetricEvent,
} from "../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";
import type { PromptCacheMetricEvent } from "../../packages/butler-agent/src/integrations/providers/prompt-cache-metrics.ts";
import {
  installTurnLatencyTracker,
  recordFirstToolEventFromTurnInput,
} from "../../packages/butler-agent/src/agent/turn/native/metrics/turn-latency-tracker.ts";
import type { RuntimeTurnInput } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

function tempRoot(): string {
  const root = join(tmpdir(), `butler-turn-latency-${Date.now()}-${Math.random()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

test("turn latency recorder writes first model and tool latencies without raw text", () => {
  const butlerData = tempRoot();
  let currentTime = 1_000;
  const budgetState = {
    status: "ok" as const,
    requestCount: 1,
    maxRequests: 32,
  };

  try {
    const recorder = createTurnLatencyMetricRecorder({
      butlerData,
      startedAt: 500,
      role: "butler",
      runtime: "native-tool-loop",
      model: "secret-password-model",
      now: () => currentTime,
    });

    currentTime = 1_200;
    recorder.recordFirstModelDelta({
      phase: "initial_tool_loop",
      target: "public_note",
    });
    currentTime = 1_300;
    recorder.recordFirstModelDelta({
      phase: "message_secret_context",
      target: "final_candidate",
    });
    currentTime = 1_400;
    recorder.recordFirstToolEvent({ eventKind: "work.block.started" });
    currentTime = 1_500;
    recorder.recordModelRequest({
      phase: "initial_tool_loop",
      roundIndex: 0,
      budgetState,
    });
    currentTime = 1_600;
    recorder.recordModelResponseUsage({
      phase: "initial_tool_loop",
      roundIndex: 0,
      promptTokens: 1_234,
      cachedTokens: 100,
      outputTokens: 22,
      totalTokens: 1_256,
      budgetState,
    });

    const rawMetrics = readFileSync(operationalMetricsPath(butlerData), "utf8");
    const events = readOperationalMetricEvents({ butlerData });

    expect(events.map((event) => event.name)).toEqual([
      FIRST_MODEL_DELTA_LATENCY_METRIC_NAME,
      FIRST_TOOL_EVENT_LATENCY_METRIC_NAME,
      MODEL_REQUEST_BY_PHASE_METRIC_NAME,
      MODEL_RESPONSE_USAGE_BY_PHASE_METRIC_NAME,
    ]);
    expect(events[0]).toMatchObject({
      durationMs: 700,
      dimensions: {
        phase: "initial_tool_loop",
        target: "public_note",
      },
    });
    expect(events[1]).toMatchObject({
      durationMs: 900,
      dimensions: {
        eventKind: "work.block.started",
      },
    });
    expect(events[3]).toMatchObject({
      value: 1_256,
      unit: "tokens",
      dimensions: {
        promptTokens: 1_234,
        cachedTokens: 100,
        outputTokens: 22,
        totalTokens: 1_256,
      },
    });
    expect(rawMetrics).not.toContain("secret-password-model");
    expect(rawMetrics).not.toContain("message_secret_context");
    expect(rawMetrics).not.toContain("SECRET_USER_TEXT");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("turn latency baseline summary flags Sandy-style delayed first model delta and request cap exhaustion", () => {
  const operationalEvents: OperationalMetricEvent[] = [
    runtimeEvent({
      name: "first_visible_latency",
      ts: 10,
      durationMs: 900,
    }),
    runtimeEvent({
      name: FIRST_MODEL_DELTA_LATENCY_METRIC_NAME,
      ts: 92_900,
      durationMs: 92_900,
      dimensions: {
        phase: "initial_tool_loop",
      },
    }),
    runtimeEvent({
      name: FIRST_TOOL_EVENT_LATENCY_METRIC_NAME,
      ts: 97_000,
      durationMs: 97_000,
      dimensions: {
        eventKind: "work.block.started",
      },
    }),
    ...Array.from({ length: 32 }, (_, index) => runtimeEvent({
      name: MODEL_REQUEST_BY_PHASE_METRIC_NAME,
      ts: 1_000 + index,
      status: index === 31 ? "error" : "ok",
      dimensions: {
        phase: "initial_tool_loop",
        roundIndex: index,
        requestCount: index + 1,
        maxRequests: 32,
        budgetStatus: index === 31 ? "exhausted" : "ok",
      },
    })),
  ];
  const promptCacheEvents: PromptCacheMetricEvent[] = Array.from({ length: 32 }, (_, index) => ({
    ts: 1_000 + index,
    model: "safe-model",
    scope: "session-turn",
    turnId: "turn-sandy-fixture",
    phase: "initial_tool_loop",
    roundIndex: index,
    promptTokens: 2_000,
    cachedTokens: 200,
    totalTokens: 2_200,
  }));

  const summary = summarizeTurnLatencyBaseline({
    operationalEvents,
    promptCacheEvents,
  });

  expect(summary).toMatchObject({
    firstVisibleProgressLatencyMs: 900,
    firstModelDeltaLatencyMs: 92_900,
    firstToolEventLatencyMs: 97_000,
    modelRequestCountByPhase: {
      initial_tool_loop: 32,
    },
    promptTokensByPhase: {
      initial_tool_loop: 64_000,
    },
    maxModelRequests: 32,
    phaseBudgetExhausted: true,
    privacy: {
      rawTextStored: false,
    },
  });
});

test("turn latency summary shows focused resume improving the Sandy-style regression shape", () => {
  const baseline = summarizeTurnLatencyBaseline({
    operationalEvents: [
      runtimeEvent({ name: FIRST_MODEL_DELTA_LATENCY_METRIC_NAME, ts: 92_900, durationMs: 92_900 }),
      ...Array.from({ length: 32 }, (_, index) => runtimeEvent({
        name: MODEL_REQUEST_BY_PHASE_METRIC_NAME,
        ts: 1_000 + index,
        status: index === 31 ? "error" : "ok",
        dimensions: {
          phase: "initial_tool_loop",
          roundIndex: index,
          requestCount: index + 1,
          maxRequests: 32,
          budgetStatus: index === 31 ? "exhausted" : "ok",
        },
      })),
    ],
    promptCacheEvents: [{
      ts: 1_000,
      model: "safe-model",
      scope: "session-turn",
      turnId: "turn-baseline",
      phase: "initial_tool_loop",
      roundIndex: 0,
      promptTokens: 80_000,
      cachedTokens: 0,
      totalTokens: 81_000,
    }],
  });
  const focused = summarizeTurnLatencyBaseline({
    operationalEvents: [
      runtimeEvent({
        name: FIRST_MODEL_DELTA_LATENCY_METRIC_NAME,
        ts: 18_000,
        durationMs: 18_000,
        dimensions: { phase: "phase_execution" },
      }),
      ...Array.from({ length: 6 }, (_, index) => runtimeEvent({
        name: MODEL_REQUEST_BY_PHASE_METRIC_NAME,
        ts: 2_000 + index,
        dimensions: {
          phase: "phase_execution",
          roundIndex: index,
          requestCount: index + 1,
          maxRequests: 32,
          budgetStatus: "ok",
        },
      })),
      runtimeEvent({
        name: PHASE_BUDGET_EXHAUSTED_METRIC_NAME,
        ts: 2_010,
        status: "error",
        dimensions: {
          phase: "phase_execution",
          reason: "phase_model_budget_exhausted",
        },
      }),
    ],
    promptCacheEvents: [{
      ts: 2_000,
      model: "safe-model",
      scope: "session-turn",
      turnId: "turn-focused",
      phase: "phase_execution",
      roundIndex: 0,
      promptTokens: 18_000,
      cachedTokens: 0,
      totalTokens: 19_000,
    }],
  });

  expect(focused.firstModelDeltaLatencyMs).toBeLessThan(baseline.firstModelDeltaLatencyMs!);
  expect(focused.modelRequestCountByPhase.phase_execution).toBeLessThan(
    baseline.modelRequestCountByPhase.initial_tool_loop!,
  );
  expect(focused.promptTokensByPhase.phase_execution).toBeLessThan(
    baseline.promptTokensByPhase.initial_tool_loop!,
  );
  expect(focused.phaseBudgetExhausted).toBe(true);
  expect(focused.maxModelRequests).toBe(32);
});

test("turn latency tracker attaches as non-enumerable runtime metadata", () => {
  const butlerData = tempRoot();
  let currentTime = 2_000;
  const turnInput = minimalTurnInput();

  try {
    installTurnLatencyTracker({
      turnInput,
      butlerData,
      startedAt: 1_000,
      role: "butler",
      runtime: "native-tool-loop",
      model: "mock/safe-model",
      now: () => currentTime,
    });
    currentTime = 2_500;
    recordFirstToolEventFromTurnInput(turnInput, "work.block.started");

    const events = readOperationalMetricEvents({ butlerData });
    expect(Object.keys(turnInput.metadata ?? {})).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: FIRST_TOOL_EVENT_LATENCY_METRIC_NAME,
      durationMs: 1_500,
      dimensions: {
        eventKind: "work.block.started",
      },
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

function runtimeEvent(input: {
  name: string;
  ts: number;
  status?: OperationalMetricEvent["status"];
  durationMs?: number;
  dimensions?: OperationalMetricEvent["dimensions"];
}): OperationalMetricEvent {
  return {
    schema: "butler.operational-metric.v1",
    ts: input.ts,
    category: "runtime",
    name: input.name,
    status: input.status ?? "ok",
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.dimensions === undefined ? {} : { dimensions: input.dimensions }),
    rawTextStored: false,
  };
}

function minimalTurnInput(): RuntimeTurnInput {
  return {
    handle: {
      sessionId: "session-latency",
      role: "butler",
      runtimeAdapterId: "native-tool-loop",
    },
    provider: {
      id: "mock-provider",
      capabilities: {
        supportsStreaming: false,
        supportsToolCalls: true,
        supportsImages: false,
        supportsAudio: false,
        supportsServerThreads: false,
        supportsReasoningConfig: false,
        supportsPromptCaching: false,
      },
      async invoke() {
        return { text: "unused" };
      },
    },
    model: "mock/safe-model",
    input: { text: "unused" },
  };
}
