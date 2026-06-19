import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PromptAssembler } from "../../packages/butler-agent/src/agent/prompt/prompt-assembler.ts";
import type { StoredSessionBinding } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import {
  appendRuntimeTurnPreparationStageMetric,
  appendRuntimeTurnContextMetric,
  contextMetricsPath,
  readContextMonitor,
} from "../../packages/butler-agent/src/operations/metrics/context-monitor.ts";
import {
  pruneContextMetricFiles,
} from "../../packages/butler-agent/src/agent/context/metrics-retention.ts";

function tempRoot(): string {
  const root = join(tmpdir(), `butler-context-monitor-${Date.now()}-${Math.random()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function binding(workspacePath: string): StoredSessionBinding {
  const now = new Date(0).toISOString();
  return {
    sessionId: "butler/main",
    role: "butler",
    projectId: "butler",
    workspacePath,
    runtimeAdapterId: "codex-api",
    modelProviderId: "openai",
    modelRef: "openai/auto:codex-latest",
    transportBindings: [],
    metadata: {},
    lifecycleState: "active",
    createdAt: now,
    updatedAt: now,
  };
}

test("context monitor records prompt section sizes without raw prompt text", () => {
  const root = tempRoot();
  const butlerHome = join(root, "home");
  const butlerData = join(root, "data");
  mkdirSync(join(butlerHome, "resources", "prompts"), { recursive: true });
  mkdirSync(join(butlerHome, "resources", "skills"), { recursive: true });

  writeFileSync(join(butlerHome, "resources", "prompts", "runtime-system-contract.md"), "SECRET_RUNTIME_CONTRACT", "utf8");
  writeFileSync(join(butlerHome, "resources", "prompts", "butler.md"), "SECRET_ROLE_RULE", "utf8");

  try {
    const assembled = new PromptAssembler({ butlerHome, butlerData }).buildSystemPrompt(binding(butlerHome));
    const metrics = readFileSync(contextMetricsPath(butlerData), "utf8");
    const summary = readContextMonitor({ butlerData, sessionId: "butler/main" });

    expect(assembled.systemPrompt).toContain("SECRET_RUNTIME_CONTRACT");
    expect(metrics).not.toContain("SECRET_RUNTIME_CONTRACT");
    expect(metrics).not.toContain("SECRET_ROLE_RULE");
    expect(summary.latestPromptAssembly?.sections.map((section) => section.id)).toEqual(["runtime-system-contract", "role"]);
    expect(summary.latestPromptAssembly?.totalChars).toBe(assembled.systemPrompt.length);
    expect(summary.privacy.rawTextStored).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context monitor summarizes runtime turn sizes and transcript growth safely", () => {
  const root = tempRoot();
  const butlerData = join(root, "data");
  mkdirSync(join(butlerData, "transcripts"), { recursive: true });
  writeFileSync(
    join(butlerData, "transcripts", "butler_main.jsonl"),
    [
      JSON.stringify({
        eventId: "inbound-1",
        sessionId: "butler/main",
        kind: "inbound",
        timestamp: "2026-04-27T00:00:00.000Z",
        payload: { message: { text: "SECRET_USER_TEXT" } },
      }),
      JSON.stringify({
        eventId: "outbound-1",
        sessionId: "butler/main",
        kind: "outbound",
        timestamp: "2026-04-27T00:00:01.000Z",
        payload: { message: { text: "SECRET_BUTLER_TEXT" } },
      }),
    ].join("\n"),
    "utf8",
  );

  try {
    appendRuntimeTurnContextMetric({
      butlerData,
      sessionId: "butler/main",
      model: "openai/auto:codex-latest",
      totalPromptChars: 1200,
      promptContextChars: 100,
      recentConversationChars: 300,
      recallContextChars: 200,
      inboundMessageChars: 50,
      now: 1,
    });
    const metrics = readFileSync(contextMetricsPath(butlerData), "utf8");
    const summary = readContextMonitor({ butlerData, sessionId: "butler/main" });

    expect(metrics).not.toContain("SECRET_USER_TEXT");
    expect(metrics).not.toContain("SECRET_BUTLER_TEXT");
    expect(summary.latestTurn).toMatchObject({
      totalPromptChars: 1200,
      recentConversationChars: 300,
      recallContextChars: 200,
      inboundMessageChars: 50,
      estimatedTokens: 300,
    });
    expect(summary.transcript).toMatchObject({
      exists: true,
      events: 2,
      conversationEvents: 2,
      latestTimestamp: "2026-04-27T00:00:01.000Z",
    });
    expect(summary.pressure.level).toBe("low");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context monitor records runtime preparation stage timings without raw text", () => {
  const root = tempRoot();
  const butlerData = join(root, "data");

  try {
    appendRuntimeTurnPreparationStageMetric({
      butlerData,
      sessionId: "butler/main",
      turnId: "turn-1",
      model: "openai/auto:codex-latest",
      stage: "automatic_recall",
      elapsedMs: 42,
      durationMs: 31,
      counters: {
        promptContextChars: 1234,
        secretText: "SECRET_RECALL_TEXT",
        attachmentCount: 2,
      },
      now: 10,
    });
    const metrics = readFileSync(contextMetricsPath(butlerData), "utf8");
    const rows = metrics.trim().split("\n").map((line) => JSON.parse(line));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "runtime_preparation_stage",
      ts: 10,
      sessionId: "butler/main",
      turnId: "turn-1",
      model: "openai/auto:codex-latest",
      stage: "automatic_recall",
      elapsedMs: 42,
      durationMs: 31,
      counters: {
        promptContextChars: 1234,
        attachmentCount: 2,
      },
    });
    expect(metrics).not.toContain("SECRET_RECALL_TEXT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context monitor computes pressure from combined prompt and turn sizes", () => {
  const root = tempRoot();
  const butlerData = join(root, "data");

  try {
    mkdirSync(join(butlerData, "metrics"), { recursive: true });
    writeFileSync(
      contextMetricsPath(butlerData),
      [
        JSON.stringify({
          kind: "prompt_assembly",
          ts: 1,
          sessionId: "butler/main",
          role: "butler",
          totalChars: 300_000,
          sections: [{ id: "core", title: "Core", chars: 300_000 }],
        }),
        JSON.stringify({
          kind: "runtime_turn",
          ts: 2,
          sessionId: "butler/main",
          model: "openai/auto:codex-latest",
          totalPromptChars: 100_000,
          promptContextChars: 0,
          recentConversationChars: 0,
          recallContextChars: 0,
          inboundMessageChars: 0,
        }),
        "{bad json",
      ].join("\n"),
      "utf8",
    );

    const summary = readContextMonitor({ butlerData, sessionId: "butler/main" });

    expect(summary.telemetry).toEqual({
      events: 2,
      parseErrors: 1,
    });
    expect(summary.pressure).toMatchObject({
      level: "low",
      thresholdState: "normal",
      contextWindowTokens: 1_050_000,
      totalChars: 400_000,
      estimatedTokens: 100_000,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context metrics retention prunes old rows and malformed lines without raw text", () => {
  const root = tempRoot();
  const butlerData = join(root, "data");

  try {
    mkdirSync(join(butlerData, "metrics"), { recursive: true });
    writeFileSync(
      contextMetricsPath(butlerData),
      [
        JSON.stringify({
          kind: "runtime_turn",
          ts: 1,
          sessionId: "butler/main",
          model: "openai/test",
          totalPromptChars: 4,
          promptContextChars: 0,
          recentConversationChars: 0,
          recallContextChars: 0,
          inboundMessageChars: 0,
        }),
        JSON.stringify({
          kind: "runtime_turn",
          ts: 10_000,
          sessionId: "butler/main",
          model: "openai/test",
          totalPromptChars: 8,
          promptContextChars: 0,
          recentConversationChars: 0,
          recallContextChars: 0,
          inboundMessageChars: 0,
        }),
        "{bad json SECRET_TEXT",
      ].join("\n"),
      "utf8",
    );

    const result = pruneContextMetricFiles({
      butlerData,
      nowMs: 10_000,
      maxAgeMs: 1_000,
    });
    const remaining = readFileSync(contextMetricsPath(butlerData), "utf8");

    expect(result.totals).toMatchObject({
      scanned: 3,
      kept: 1,
      deleted: 1,
      parseErrors: 1,
      rawTextStored: false,
    });
    const rows = remaining.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0].ts).toBe(10_000);
    expect(rows[0].rawTextStored).toBe(false);
    expect(remaining).not.toContain("SECRET_TEXT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
