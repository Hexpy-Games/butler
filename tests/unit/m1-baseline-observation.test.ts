import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PromptUsageReport } from "../../packages/butler-agent/src/integrations/providers/runtime-contracts.ts";
import {
  M1_BASELINE_OBSERVATION_EVENT_NAME,
  createM1BaselineObservationRecorder,
} from "../../packages/butler-agent/src/operations/metrics/m1-baseline-observation.ts";
import {
  operationalMetricsPath,
  readOperationalMetricEvents,
} from "../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";

function tempRoot(suffix: string): string {
  return join(tmpdir(), `butler-m1-${suffix}-${Date.now()}-${Math.random()}`);
}

function acceptedMetadata() {
  return {
    armId: "direct-cold",
    scenario: "direct",
    cacheState: "cold" as const,
    sourceRevision: "65494154f6e9ddbfb20458bc67250c7d15b5d13d",
    modelRef: "openai/gpt-5.6-sol",
    reasoning: "medium",
    flagRevision: "m1-t1-v1",
    armState: "accepted" as const,
  };
}

function providerUsage(): PromptUsageReport {
  return {
    model: "openai/gpt-5.6-sol",
    promptTokens: 100,
    cachedTokens: 10,
    totalTokens: 130,
    outputTokens: 30,
    providerPromptTokens: 100,
    providerCacheReadTokens: 10,
    providerCacheWriteTokens: null,
    providerOutputTokens: 30,
    providerTotalTokens: 130,
  };
}

test("M1 baseline observation records safe dimensions and redacts unsafe metadata", () => {
  const butlerData = tempRoot("redaction");
  try {
    const recorder = createM1BaselineObservationRecorder({
      butlerData,
      startedAtMs: 1_000,
      now: () => 1_250,
      metadata: {
        ...acceptedMetadata(),
        modelRef: "https://secret.example/prompt?value=raw-message",
        sourceRevision: "/srv/private/project",
      },
      env: { BUTLER_M1_BASELINE_TELEMETRY: "on" },
    });
    recorder.observeModelRequest();
    recorder.observeSerializedInputEstimate(42, "openai/gpt-5.6-sol");
    recorder.observeProviderUsage(providerUsage());
    recorder.observeFirstUseful();
    recorder.observeToolCall();
    recorder.observeToolResult(false);
    recorder.finalize("ok");

    const [event] = readOperationalMetricEvents({ butlerData });
    expect(event).toMatchObject({
      category: "runtime",
      name: M1_BASELINE_OBSERVATION_EVENT_NAME,
      status: "ok",
      unit: "arm",
      rawTextStored: false,
      dimensions: {
        armId: "direct-cold",
        scenario: "direct",
        cacheState: "cold",
        sourceRevision: null,
        modelRef: null,
        reasoning: "medium",
        flagRevision: "m1-t1-v1",
        armState: "measurement-ineligible",
        serializedInputEstimateTokens: 42,
        providerPromptTokens: 100,
        providerCacheReadTokens: 10,
        providerCacheWriteTokens: null,
        providerOutputTokens: 30,
        providerTotalTokens: 130,
        modelRequests: 1,
        firstUsefulLatencyMs: 250,
        elapsedMs: 250,
        toolCalls: 1,
        toolFailures: 1,
      },
    });
    const raw = readFileSync(operationalMetricsPath(butlerData), "utf8");
    expect(raw).not.toContain("secret.example");
    expect(raw).not.toContain("raw-message");
    expect(raw).not.toContain("/srv/private/project");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("M1 baseline observation preserves unavailable provider values as null", () => {
  const butlerData = tempRoot("nulls");
  try {
    const recorder = createM1BaselineObservationRecorder({
      butlerData,
      metadata: acceptedMetadata(),
      env: { BUTLER_M1_BASELINE_TELEMETRY: "on" },
    });
    recorder.observeProviderUsage({
      model: "openai/gpt-5.6-sol",
      promptTokens: null,
      cachedTokens: 0,
      totalTokens: null,
      outputTokens: 0,
      providerPromptTokens: null,
      providerCacheReadTokens: null,
      providerCacheWriteTokens: null,
      providerOutputTokens: null,
      providerTotalTokens: null,
    });
    recorder.finalize("skipped");

    const [event] = readOperationalMetricEvents({ butlerData });
    expect(event?.status).toBe("skipped");
    expect(event?.dimensions).toMatchObject({
      serializedInputEstimateTokens: null,
      localInputEstimateTokens: null,
      providerPromptTokens: null,
      providerCacheReadTokens: null,
      providerCacheWriteTokens: null,
      providerOutputTokens: null,
      providerTotalTokens: null,
      modelRequests: 0,
      firstUsefulLatencyMs: null,
      elapsedMs: expect.any(Number),
      toolCalls: 0,
      toolFailures: 0,
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("M1 baseline observation reads only bounded arm metadata from config", () => {
  const butlerData = tempRoot("config");
  try {
    mkdirSync(butlerData, { recursive: true });
    writeFileSync(join(butlerData, "butler.config.json"), JSON.stringify({
      metrics: {
        m1BaselineTelemetry: {
          armId: "current-web-cold",
          scenario: "current-web",
          cacheState: "cold",
          sourceRevision: "65494154f6e9ddbfb20458bc67250c7d15b5d13d",
          modelRef: "google/gemini-3.1-pro-preview",
          reasoning: "high",
          flagRevision: "m1-t1-v2",
          armState: "gated",
          prompt: "must never be copied",
        },
      },
    }));
    const recorder = createM1BaselineObservationRecorder({
      butlerData,
      env: {},
    });
    recorder.finalize("skipped");

    const [event] = readOperationalMetricEvents({ butlerData });
    expect(event?.dimensions).toMatchObject({
      armId: "current-web-cold",
      scenario: "current-web",
      cacheState: "cold",
      sourceRevision: "65494154f6e9ddbfb20458bc67250c7d15b5d13d",
      modelRef: "google/gemini-3.1-pro-preview",
      reasoning: "high",
      flagRevision: "m1-t1-v2",
      armState: "gated",
    });
    expect(JSON.stringify(event)).not.toContain("must never be copied");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("M1 baseline observation finalization is idempotent and flag-off is a no-op", () => {
  const butlerData = tempRoot("idempotency");
  try {
    const recorder = createM1BaselineObservationRecorder({
      butlerData,
      metadata: acceptedMetadata(),
      env: { BUTLER_M1_BASELINE_TELEMETRY: "on" },
    });
    recorder.finalize("ok");
    recorder.observeModelRequest();
    recorder.finalize("error");
    expect(readOperationalMetricEvents({ butlerData })).toHaveLength(1);

    const disabledData = tempRoot("disabled");
    try {
      const disabled = createM1BaselineObservationRecorder({
        butlerData: disabledData,
        metadata: acceptedMetadata(),
        env: { BUTLER_M1_BASELINE_TELEMETRY: "off" },
      });
      disabled.observeModelRequest();
      disabled.finalize("ok");
      expect(readOperationalMetricEvents({ butlerData: disabledData })).toEqual([]);
    } finally {
      rmSync(disabledData, { recursive: true, force: true });
    }
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("M1 baseline observation preserves every explicit arm eligibility state", () => {
  const states = ["accepted", "rejected", "gated", "measurement-ineligible"] as const;
  for (const state of states) {
    const butlerData = tempRoot(`state-${state}`);
    try {
      const recorder = createM1BaselineObservationRecorder({
        butlerData,
        metadata: { ...acceptedMetadata(), armState: state },
        env: { BUTLER_M1_BASELINE_TELEMETRY: "on" },
      });
      recorder.finalize("skipped");
      const [event] = readOperationalMetricEvents({ butlerData });
      expect(event?.dimensions?.armState, state).toBe(state);
    } finally {
      rmSync(butlerData, { recursive: true, force: true });
    }
  }
});

test("M1 baseline metadata rejects private paths, credential-like values, and free text", () => {
  const cases = [
    {
      field: "sourceRevision" as const,
      value: "C:/Users/name/private",
    },
    {
      field: "sourceRevision" as const,
      value: "Users/name/private",
    },
    {
      field: "modelRef" as const,
      value: "sk-proj-test-redaction",
    },
    {
      field: "modelRef" as const,
      value: "openai/sk-proj-test-redaction",
    },
    {
      field: "modelRef" as const,
      value: "local/users-private-model",
    },
    {
      field: "modelRef" as const,
      value: "file/path",
    },
    {
      field: "scenario" as const,
      value: "prompt-like free text",
    },
    {
      field: "armState" as const,
      value: "accepted-with-extra-meaning",
    },
  ];

  for (const [index, candidate] of cases.entries()) {
    const butlerData = tempRoot(`metadata-rejection-${index}`);
    try {
      const recorder = createM1BaselineObservationRecorder({
        butlerData,
        metadata: {
          ...acceptedMetadata(),
          [candidate.field]: candidate.value,
        },
        env: { BUTLER_M1_BASELINE_TELEMETRY: "on" },
      });
      recorder.finalize("skipped");

      const [event] = readOperationalMetricEvents({ butlerData });
      expect(event?.dimensions).toMatchObject({
        [candidate.field]: null,
        armState: "measurement-ineligible",
      });
      expect(JSON.stringify(event)).not.toContain(candidate.value);
    } finally {
      rmSync(butlerData, { recursive: true, force: true });
    }
  }
});
