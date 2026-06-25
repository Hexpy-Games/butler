import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NativeToolLoopRuntime } from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import type { ModelProviderAdapter } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import {
  TURN_PREPARATION_STEP_METRIC_NAME,
  readFirstVisibleLatencySummary,
  type TurnPreparationStep,
} from "../../packages/butler-agent/src/operations/metrics/first-visible-latency.ts";
import {
  operationalMetricsPath,
  readOperationalMetricEvents,
} from "../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";

const mockProvider: ModelProviderAdapter = {
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
};

function tempRoot(): string {
  return join(tmpdir(), `butler-native-prep-metrics-${Date.now()}-${Math.random()}`);
}

test("native runtime records preparation substep timers without raw text", async () => {
  const root = tempRoot();
  const butlerData = join(root, "data");
  const originalData = process.env.BUTLER_DATA;
  process.env.BUTLER_DATA = butlerData;

  try {
    const runtime = new NativeToolLoopRuntime({
      butlerHome: root,
      butlerData,
      disableAutomaticRecall: true,
      runFunctionToolPromptText: async () => "done",
    });
    const handle = await runtime.createSession({
      sessionId: "butler/main",
      role: "butler",
      workspacePath: root,
      systemPrompt: "system",
    });

    const result = await runtime.runTurn({
      handle,
      provider: mockProvider,
      model: "openai/auto:codex-latest",
      input: { text: "SECRET_USER_TEXT run status check" },
    });
    const events = readOperationalMetricEvents({ butlerData })
      .filter((event) => event.name === TURN_PREPARATION_STEP_METRIC_NAME);
    const steps = new Set(events.map((event) => event.dimensions?.step as TurnPreparationStep | undefined));
    const firstVisible = readFirstVisibleLatencySummary({ butlerData });
    const rawMetrics = readFileSync(operationalMetricsPath(butlerData), "utf8");

    expect(result.text).toBe("done");
    expect(steps).toEqual(new Set<TurnPreparationStep>([
      "context_compaction",
      "automatic_recall",
      "compaction_context",
      "feedback_buffer",
      "working_memory",
      "runtime_policy",
      "prompt_normalization",
      "attachment_context",
      "runtime_preparation_progress",
    ]));
    expect(events.every((event) => event.category === "runtime")).toBe(true);
    expect(events.every((event) => typeof event.durationMs === "number")).toBe(true);
    expect(events.find((event) => event.dimensions?.step === "automatic_recall")?.status).toBe("skipped");
    expect(firstVisible).toMatchObject({
      events: 1,
      bySignal: {
        runtime_preparation: 1,
      },
    });
    expect(rawMetrics).not.toContain("SECRET_USER_TEXT");
  } finally {
    if (originalData === undefined) {
      delete process.env.BUTLER_DATA;
    } else {
      process.env.BUTLER_DATA = originalData;
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
