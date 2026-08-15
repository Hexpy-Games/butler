import { expect, test } from "bun:test";
import { mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { recordWebSearchMetric } from "../../packages/butler-agent/src/integrations/search/provider.ts";
import {
  appendPromptCacheMetric,
  summarizePromptCacheMetricsFromDisk,
} from "../../packages/butler-agent/src/integrations/providers/prompt-cache-metrics.ts";
import { modelIterationLimitWithinUsageBudget } from
  "../../packages/butler-agent/src/integrations/providers/shared/usage.ts";
import { readUsageMonitor } from "../../packages/butler-agent/src/operations/metrics/usage-monitor.ts";
import { rebuildTranscriptActivityAggregate } from
  "../../packages/butler-agent/src/operations/metrics/transcript-activity-index.ts";
import { ensureTranscriptActivityAggregate } from
  "../../packages/butler-agent/src/operations/metrics/transcript-activity-index.ts";
import { readTranscriptActivityAggregate } from
  "../../packages/butler-agent/src/operations/metrics/transcript-activity-index.ts";
import {
  appendTranscriptEvent,
  createTranscriptEvent,
} from "../../packages/butler-agent/src/test-support/harness/transcripts.ts";

function tempRoot(): string {
  const root = join(tmpdir(), `butler-usage-monitor-${Date.now()}-${Math.random()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

test("unbounded guided rounds remain bounded by any finite provider usage budget", () => {
  expect(modelIterationLimitWithinUsageBudget(Number.POSITIVE_INFINITY))
    .toBe(Number.POSITIVE_INFINITY);
  expect(modelIterationLimitWithinUsageBudget(4)).toBe(4);
  expect(modelIterationLimitWithinUsageBudget(100)).toBe(60);
  expect(modelIterationLimitWithinUsageBudget(Number.POSITIVE_INFINITY, {
    budgetState: {
      status: "ok",
      requestCount: 2,
      maxRequests: 8,
    },
  })).toBe(5);
});

test("usage monitor summarizes model cache and search usage without private queries", () => {
  const butlerData = tempRoot();

  try {
    appendPromptCacheMetric({
      ts: 1000,
      model: "openai/auto:codex-latest",
      scope: "session-turn",
      promptTokens: 100,
      cachedTokens: 25,
      totalTokens: 180,
    }, { butlerData });
    appendPromptCacheMetric({
      ts: 2000,
      model: "openai/auto:codex-latest",
      scope: "worker",
      promptTokens: 40,
      cachedTokens: 0,
      totalTokens: 70,
    }, { butlerData });
    recordWebSearchMetric({
      butlerData,
      provider: "duckduckgo-html",
      query: "SECRET_SEARCH_QUERY",
    });

    const summary = readUsageMonitor({ butlerData });

    expect(summary.model).toMatchObject({
      requestCount: 2,
      promptTokens: 140,
      cachedTokens: 25,
      uncachedTokens: 115,
      outputTokens: 110,
      totalTokens: 250,
      missingTotalTokenCount: 0,
      byScope: {
        "session-turn": 1,
        worker: 1,
      },
      byScopeUsage: {
        "session-turn": {
          requestCount: 1,
          promptTokens: 100,
          cachedTokens: 25,
          uncachedTokens: 75,
          outputTokens: 80,
          totalTokens: 180,
          missingTotalTokenCount: 0,
        },
        worker: {
          requestCount: 1,
          promptTokens: 40,
          cachedTokens: 0,
          uncachedTokens: 40,
          outputTokens: 30,
          totalTokens: 70,
          missingTotalTokenCount: 0,
        },
      },
      byModel: {
        "openai/auto:codex-latest": {
          requestCount: 2,
          promptTokens: 140,
          cachedTokens: 25,
          uncachedTokens: 115,
          outputTokens: 110,
          totalTokens: 250,
          missingTotalTokenCount: 0,
        },
      },
    });
    expect(summary.providerUsage.providers).toEqual([
      expect.objectContaining({
        providerId: "openai",
        requestCount: 2,
        promptTokens: 140,
        totalTokens: 250,
        source: "local_telemetry",
        remaining: expect.objectContaining({
          available: false,
          reason: expect.objectContaining({
            code: "provider_quota_surface_unavailable",
            message: expect.stringContaining("quota"),
          }),
        }),
        billing: expect.objectContaining({
          available: false,
          reason: expect.stringContaining("billing"),
        }),
      }),
    ]);
    expect(summary.webSearch).toEqual({
      requestCount: 1,
      lastProvider: "duckduckgo-html",
      lastError: null,
    });
    expect(JSON.stringify(summary)).not.toContain("SECRET_SEARCH_QUERY");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("usage monitor handles missing telemetry files safely", () => {
  const butlerData = tempRoot();

  try {
    const summary = readUsageMonitor({ butlerData });

    expect(summary.model).toMatchObject({
      requestCount: 0,
      promptTokens: 0,
      cachedTokens: 0,
      uncachedTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      byScopeUsage: {},
      byModel: {},
    });
    expect(summary.webSearch).toEqual({
      requestCount: 0,
      lastProvider: null,
      lastError: null,
    });
    expect(summary.providerUsage).toEqual({
      activeProviderId: null,
      providers: [],
    });
    expect(summary.tools).toMatchObject({
      calls: 0,
      results: 0,
      successes: 0,
      failures: 0,
      byTool: {},
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("usage monitor reports aggregate rebuild status instead of false-zero health", () => {
  const butlerData = tempRoot();
  try {
    const summary = readUsageMonitor({ butlerData });
    expect(summary.tools.calls).toBe(0);
    expect(summary.availability.transcriptActivity).toEqual({
      status: "degraded",
      reason: "transcript_activity_checkpoint_rebuilt",
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("unscoped usage time filter is explicitly unavailable", () => {
  const butlerData = tempRoot();
  try {
    const summary = readUsageMonitor({ butlerData, sinceTs: Date.now() - 1_000 });
    expect(summary.availability.tools).toEqual({
      status: "unavailable",
      reason: "unscoped_since_filter_requires_session",
    });
    expect(summary.tools.calls).toBe(0);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("bounded prompt-cache disk summary caps unique scopes", () => {
  const butlerData = tempRoot();
  try {
    for (let index = 0; index < 1_200; index += 1) {
      appendPromptCacheMetric({
        ts: index,
        model: "openai/gpt-5.6-sol",
        scope: `unique-scope-${index}`,
        promptTokens: 10,
        cachedTokens: 2,
      }, { butlerData });
    }
    const result = summarizePromptCacheMetricsFromDisk({ butlerData });
    expect(result.summary.requestCount).toBe(1_200);
    expect(Object.keys(result.summary.byScope).length).toBeLessThanOrEqual(513);
    expect(result.summary.byScope.__other__).toBe(688);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("usage monitor excludes unexpected raw fields from token telemetry summaries", () => {
  const butlerData = tempRoot();

  try {
    const metric = {
      ts: 1000,
      model: "openai/auto:codex-latest",
      scope: "session-turn",
      promptTokens: 10,
      cachedTokens: 1,
      totalTokens: 20,
      prompt: "SECRET_PROMPT_TEXT",
    };
    appendPromptCacheMetric(metric, { butlerData });

    const summary = readUsageMonitor({ butlerData });

    expect(summary.model.requestCount).toBe(1);
    expect(JSON.stringify(summary)).not.toContain("SECRET_PROMPT_TEXT");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("usage monitor groups provider usage by turn, phase, warning state, and prompt section", () => {
  const butlerData = tempRoot();

  try {
    appendPromptCacheMetric({
      ts: 1000,
      model: "openai/auto:codex-latest",
      scope: "session-turn",
      turnId: "turn-token-budget",
      phase: "initial_tool_loop",
      roundIndex: 0,
      reasoningEffort: "high",
      promptTokens: 80_000,
      cachedTokens: 20_000,
      totalTokens: 90_000,
      promptCacheKey: "butler-session-turn",
      promptCacheRetention: "24h",
      budgetState: {
        status: "warning",
        requestCount: 26,
        maxRequests: 32,
        promptTokens: 80_000,
        cachedTokens: 20_000,
        outputTokens: 10_000,
        totalTokens: 90_000,
        maxPromptTokens: 220_000,
        maxOutputTokens: 80_000,
        maxTotalTokens: 300_000,
      },
      promptSections: [
        { id: "recent_conversation", chars: 120_000, estimatedTokens: 30_000 },
        { id: "project_ledger", chars: 20_000, estimatedTokens: 5_000 },
      ],
    }, { butlerData });
    appendPromptCacheMetric({
      ts: 2000,
      model: "openai/auto:codex-latest",
      scope: "session-turn",
      turnId: "turn-token-budget",
      phase: "direct_work_continuation",
      roundIndex: 1,
      reasoningEffort: "high",
      promptTokens: 40_000,
      cachedTokens: 10_000,
      totalTokens: 55_000,
      promptCacheKey: "butler-session-turn",
      promptCacheRetention: "24h",
      budgetState: {
        status: "warning",
        requestCount: 33,
        maxRequests: 32,
        promptTokens: 120_000,
        cachedTokens: 30_000,
        outputTokens: 25_000,
        totalTokens: 145_000,
        maxPromptTokens: 220_000,
        maxOutputTokens: 80_000,
        maxTotalTokens: 300_000,
      },
      promptSections: [
        { id: "recent_conversation", chars: 20_000, estimatedTokens: 5_000 },
        { id: "tool_loop", chars: 40_000, estimatedTokens: 10_000 },
      ],
    }, { butlerData });

    const summary = readUsageMonitor({ butlerData });

    expect(summary.model.byTurn["turn-token-budget"]).toMatchObject({
      requestCount: 2,
      promptTokens: 120_000,
      cachedTokens: 30_000,
      uncachedTokens: 90_000,
      outputTokens: 25_000,
      totalTokens: 145_000,
    });
    expect(summary.model.byPhase.initial_tool_loop.requestCount).toBe(1);
    expect(summary.model.byPhase.direct_work_continuation.totalTokens).toBe(55_000);
    expect(summary.model.byTurnPhase["turn-token-budget:direct_work_continuation"].promptTokens).toBe(40_000);
    expect(summary.model.bySection.recent_conversation).toEqual({
      requestCount: 2,
      chars: 140_000,
      estimatedTokens: 35_000,
    });
    expect(summary.model.budgetStates["turn-token-budget"]).toMatchObject({
      status: "warning",
      requestCount: 33,
      maxRequests: 32,
      promptTokens: 120_000,
      cachedTokens: 30_000,
      outputTokens: 25_000,
      totalTokens: 145_000,
    });
    expect(summary.model.promptCache).toEqual({
      missingKeyCount: 0,
      missingRetentionCount: 0,
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("usage monitor bounds budget states across many turn ids", () => {
  const butlerData = tempRoot();

  try {
    // Saturate the independent byTurn projection first. budgetStates must
    // retain its own bounded set instead of inheriting that projection's
    // overflow key.
    for (let index = 0; index < 512; index += 1) {
      appendPromptCacheMetric({
        ts: index,
        model: "openai/gpt-5.6-sol",
        scope: "session-turn",
        turnId: `baseline-${index}`,
        promptTokens: 10,
        cachedTokens: 2,
      }, { butlerData });
    }
    for (let index = 0; index < 1_200; index += 1) {
      appendPromptCacheMetric({
        ts: 512 + index,
        model: "openai/gpt-5.6-sol",
        scope: "session-turn",
        turnId: `budget-${index}`,
        promptTokens: 10,
        cachedTokens: 2,
        budgetState: {
          status: index === 1_199 ? "exhausted" : "warning",
          requestCount: index + 1,
          maxRequests: 1_200,
        },
      }, { butlerData });
    }

    const budgetStates = readUsageMonitor({ butlerData }).model.budgetStates;

    expect(Object.keys(budgetStates).length).toBeLessThanOrEqual(513);
    expect(budgetStates["budget-0"]).toMatchObject({
      status: "warning",
      requestCount: 1,
    });
    expect(budgetStates.__other__).toMatchObject({
      status: "exhausted",
      requestCount: 1_200,
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("usage monitor derives tool counts from transcripts without raw arguments or results", () => {
  const butlerData = tempRoot();
  mkdirSync(join(butlerData, "transcripts"), { recursive: true });
  writeFileSync(
    join(butlerData, "transcripts", "butler_main.jsonl"),
    [
      JSON.stringify({
        eventId: "tool-call-1",
        sessionId: "butler/main",
        kind: "tool_call",
        timestamp: "2026-04-27T00:00:00.000Z",
        payload: {
          name: "web_search",
          arguments: { query: "SECRET_TOOL_ARGUMENT" },
        },
      }),
      JSON.stringify({
        eventId: "tool-result-1",
        sessionId: "butler/main",
        kind: "tool_result",
        timestamp: "2026-04-27T00:00:01.000Z",
        payload: {
          name: "web_search",
          ok: true,
          result: { text: "SECRET_TOOL_RESULT" },
        },
      }),
      JSON.stringify({
        eventId: "tool-call-2",
        sessionId: "butler/main",
        kind: "tool_call",
        timestamp: "2026-04-27T00:00:02.000Z",
        payload: {
          name: "dispatch_worker",
          arguments: { task: "SECRET_TASK" },
        },
      }),
      JSON.stringify({
        eventId: "tool-result-2",
        sessionId: "butler/main",
        kind: "tool_result",
        timestamp: "2026-04-27T00:00:03.000Z",
        payload: {
          name: "dispatch_worker",
          ok: false,
          error: "SECRET_ERROR",
        },
      }),
    ].join("\n"),
    "utf8",
  );
  rebuildTranscriptActivityAggregate({ butlerData });

  try {
    const summary = readUsageMonitor({ butlerData, sessionId: "butler/main" });

    expect(summary.tools).toMatchObject({
      calls: 2,
      results: 2,
      successes: 1,
      failures: 1,
      byTool: {
        web_search: {
          calls: 1,
          results: 1,
          successes: 1,
          failures: 0,
        },
        dispatch_worker: {
          calls: 1,
          results: 1,
          successes: 0,
          failures: 1,
        },
      },
    });
    expect(JSON.stringify(summary)).not.toContain("SECRET_TOOL_ARGUMENT");
    expect(JSON.stringify(summary)).not.toContain("SECRET_TOOL_RESULT");
    expect(JSON.stringify(summary)).not.toContain("SECRET_TASK");
    expect(JSON.stringify(summary)).not.toContain("SECRET_ERROR");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("unfiltered usage keeps transcript tool buckets bounded across sessions", () => {
  const butlerData = tempRoot();
  const transcripts = join(butlerData, "transcripts");
  mkdirSync(transcripts, { recursive: true });
  writeFileSync(
    join(transcripts, "first.jsonl"),
    Array.from({ length: 1_200 }, (_, index) => JSON.stringify({
      kind: "tool_call",
      timestamp: "2026-04-27T00:00:00.000Z",
      payload: { name: `tool-${index}` },
    })).join("\n") + "\n",
    "utf8",
  );
  rebuildTranscriptActivityAggregate({ butlerData });

  try {
    const initial = readUsageMonitor({ butlerData });
    expect(initial.tools.calls).toBe(1_200);
    expect(Object.keys(initial.tools.byTool).length).toBeLessThanOrEqual(513);

    appendTranscriptEvent(createTranscriptEvent({
      sessionId: "second",
      kind: "tool_result",
      timestamp: "2026-04-27T00:00:01.000Z",
      payload: { name: "new-tool", ok: true },
    }), butlerData);
    const appended = readUsageMonitor({ butlerData });
    expect(appended.tools.results).toBe(1);
    expect(appended.tools.successes).toBe(1);
    expect(Object.keys(appended.tools.byTool).length).toBeLessThanOrEqual(513);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("aggregate transcript activity stays exact across concurrent append callers", async () => {
  const butlerData = tempRoot();
  try {
    await Promise.all(Array.from({ length: 32 }, (_, index) => Promise.resolve().then(() => {
      appendTranscriptEvent(createTranscriptEvent({
        sessionId: `concurrent-${index}`,
        kind: "tool_call",
        timestamp: "2026-04-27T00:00:00.000Z",
        payload: { name: `tool-${index}` },
      }), butlerData);
    })));

    const summary = readUsageMonitor({ butlerData });
    expect(summary.tools.calls).toBe(32);
    expect(Object.keys(summary.tools.byTool).length).toBeLessThanOrEqual(33);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("aggregate delta recovery makes lock-contention appends visible without restart", () => {
  const butlerData = tempRoot();
  const lockDir = join(butlerData, "metrics", "transcript-activity");
  try {
    mkdirSync(lockDir, { recursive: true });
    mkdirSync(join(lockDir, "aggregate.lock"));
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: "lock-contention-1",
      kind: "tool_call",
      timestamp: "2026-04-27T00:00:00.000Z",
      payload: { name: "first-tool" },
    }), butlerData);
    rmSync(join(lockDir, "aggregate.lock"), { recursive: true, force: true });
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: "lock-contention-2",
      kind: "tool_call",
      timestamp: "2026-04-27T00:00:01.000Z",
      payload: { name: "second-tool" },
    }), butlerData);

    const summary = readUsageMonitor({ butlerData });
    expect(summary.tools.calls).toBe(2);
    expect(summary.tools.byTool["first-tool"]?.calls).toBe(1);
    expect(summary.tools.byTool["second-tool"]?.calls).toBe(1);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("usage monitor preserves the last aggregate under a held lock and marks it degraded", () => {
  const butlerData = tempRoot();
  const lockPath = join(butlerData, "metrics", "transcript-activity", "aggregate.lock");
  try {
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: "held-lock-valid-checkpoint",
      kind: "tool_call",
      timestamp: "2026-04-27T00:00:00.000Z",
      payload: { name: "checkpoint-tool" },
    }), butlerData);
    mkdirSync(join(lockPath, ".."), { recursive: true });
    mkdirSync(lockPath);
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: "held-lock-valid-checkpoint",
      kind: "tool_call",
      timestamp: "2026-04-27T00:00:01.000Z",
      payload: { name: "pending-tool" },
    }), butlerData);

    const summary = readUsageMonitor({ butlerData });

    expect(summary.tools.calls).toBe(1);
    expect(summary.tools.byTool["checkpoint-tool"]?.calls).toBe(1);
    expect(summary.tools.byTool["pending-tool"]).toBeUndefined();
    expect(summary.availability.transcriptActivity).toEqual({
      status: "degraded",
      reason: "transcript_activity_aggregate_lock_contended",
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("aggregate rebuild keeps unknown delivery failures separate from timestamped failures", () => {
  const butlerData = tempRoot();
  const transcripts = join(butlerData, "transcripts");
  try {
    const recentTimestamp = new Date(Date.now() - 1_000).toISOString();
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(join(transcripts, "delivery.jsonl"), [
      JSON.stringify({
        kind: "delivery",
        timestamp: recentTimestamp,
        payload: { ok: false, error: "timestamped" },
      }),
      JSON.stringify({
        kind: "delivery",
        timestamp: "not-a-timestamp",
        payload: { ok: false, error: "unknown-time" },
      }),
      "",
    ].join("\n"), "utf8");
    const rebuilt = ensureTranscriptActivityAggregate({ butlerData });
    expect(rebuilt.deliveryFailed).toBe(2);
    expect(readTranscriptActivityAggregate({ butlerData }).deliveryFailed).toBe(2);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("lock-fallback delta preserves omitted tool-result ok as success", () => {
  const butlerData = tempRoot();
  const lockDir = join(butlerData, "metrics", "transcript-activity");
  try {
    mkdirSync(join(butlerData, "transcripts"), { recursive: true });
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: "delta-semantics",
      kind: "tool_call",
      timestamp: "2026-04-27T00:00:00.000Z",
      payload: { name: "lookup" },
    }), butlerData);
    ensureTranscriptActivityAggregate({ butlerData });
    mkdirSync(lockDir, { recursive: true });
    mkdirSync(join(lockDir, "aggregate.lock"));
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: "delta-semantics",
      kind: "tool_result",
      timestamp: "2026-04-27T00:00:01.000Z",
      payload: { name: "lookup" },
    }), butlerData);
    rmSync(join(lockDir, "aggregate.lock"), { recursive: true, force: true });
    const summary = ensureTranscriptActivityAggregate({ butlerData });
    expect(summary.tools.results).toBe(1);
    expect(summary.tools.successes).toBe(1);
    expect(summary.tools.failures).toBe(0);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("aggregate ensure skips transcript discovery when checkpoint is valid and rebuilds corruption", () => {
  const butlerData = tempRoot();
  const transcripts = join(butlerData, "transcripts");
  const aggregatePath = join(butlerData, "metrics", "transcript-activity", "aggregate.json");
  try {
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(
      join(transcripts, "first.jsonl"),
      `${JSON.stringify({
        kind: "tool_call",
        timestamp: "2026-04-27T00:00:00.000Z",
        payload: { name: "first-tool" },
      })}\n`,
      "utf8",
    );
    const initial = ensureTranscriptActivityAggregate({ butlerData });
    const initialMtime = statSync(aggregatePath).mtimeMs;

    // A valid checkpoint is sufficient for the next startup; canonical
    // transcript discovery is intentionally not required on this path.
    rmSync(transcripts, { recursive: true, force: true });
    const second = ensureTranscriptActivityAggregate({ butlerData });
    expect(second).toEqual(initial);
    expect(statSync(aggregatePath).mtimeMs).toBe(initialMtime);

    mkdirSync(transcripts, { recursive: true });
    writeFileSync(
      join(transcripts, "restored.jsonl"),
      `${JSON.stringify({
        kind: "tool_call",
        timestamp: "2026-04-27T00:00:01.000Z",
        payload: { name: "restored-tool" },
      })}\n`,
      "utf8",
    );
    writeFileSync(aggregatePath, "not-json\n", "utf8");
    const rebuilt = ensureTranscriptActivityAggregate({ butlerData });
    expect(rebuilt.tools.calls).toBe(1);
    expect(rebuilt.byTool["restored-tool"]?.calls).toBe(1);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("usage monitor supports time filters and explicit unavailable cost", () => {
  const butlerData = tempRoot();
  mkdirSync(join(butlerData, "transcripts"), { recursive: true });
  writeFileSync(
    join(butlerData, "transcripts", "butler_main.jsonl"),
    [
      JSON.stringify({
        eventId: "old-call",
        sessionId: "butler/main",
        kind: "tool_call",
        timestamp: "2026-04-26T00:00:00.000Z",
        payload: { name: "web_search" },
      }),
      JSON.stringify({
        eventId: "new-call",
        sessionId: "butler/main",
        kind: "tool_call",
        timestamp: "2026-04-27T00:00:00.000Z",
        payload: { name: "recall_memory" },
      }),
    ].join("\n"),
    "utf8",
  );
  appendPromptCacheMetric({
    ts: Date.parse("2026-04-26T00:00:00.000Z"),
    model: "openai/auto:codex-latest",
    scope: "old",
    promptTokens: 10,
    cachedTokens: 0,
  }, { butlerData });
  appendPromptCacheMetric({
    ts: Date.parse("2026-04-27T00:00:00.000Z"),
    model: "openai/auto:codex-latest",
    scope: "new",
    promptTokens: 20,
    cachedTokens: 5,
  }, { butlerData });
  recordWebSearchMetric({
    butlerData,
    provider: "old-search",
    query: "SECRET_OLD_QUERY",
    ts: Date.parse("2026-04-26T00:00:00.000Z"),
  });
  recordWebSearchMetric({
    butlerData,
    provider: "new-search",
    query: "SECRET_NEW_QUERY",
    ts: Date.parse("2026-04-27T00:00:00.000Z"),
  });

  try {
    const summary = readUsageMonitor({
      butlerData,
      sessionId: "butler/main",
      sinceTs: Date.parse("2026-04-26T12:00:00.000Z"),
    });

    expect(summary.filters).toEqual({
      sessionId: "butler/main",
      sinceTs: Date.parse("2026-04-26T12:00:00.000Z"),
    });
    expect(summary.model).toMatchObject({
      requestCount: 1,
      promptTokens: 20,
      cachedTokens: 5,
      uncachedTokens: 15,
      outputTokens: 0,
      missingTotalTokenCount: 1,
    });
    expect(summary.tools.calls).toBe(1);
    expect(summary.tools.byTool).toEqual({
      recall_memory: {
        calls: 1,
        results: 0,
        successes: 0,
        failures: 0,
      },
    });
    expect(summary.webSearch).toEqual({
      requestCount: 1,
      lastProvider: "new-search",
      lastError: null,
    });
    expect(summary.providerUsage.providers).toEqual([
      expect.objectContaining({
        providerId: "openai",
        requestCount: 1,
        promptTokens: 20,
        cachedTokens: 5,
        missingTotalTokenCount: 1,
      }),
    ]);
    expect(JSON.stringify(summary)).not.toContain("SECRET_OLD_QUERY");
    expect(JSON.stringify(summary)).not.toContain("SECRET_NEW_QUERY");
    expect(summary.cost).toEqual({
      available: false,
      estimatedUsd: null,
      reason: "No authoritative provider price table is configured for this runtime/model.",
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("usage monitor chooses the newest web-search event even when the log is out of order", () => {
  const butlerData = tempRoot();
  try {
    recordWebSearchMetric({
      butlerData,
      provider: "new-search",
      query: "SECRET_NEW_QUERY",
      ts: 2_000,
    });
    recordWebSearchMetric({
      butlerData,
      provider: "old-search",
      query: "SECRET_OLD_QUERY",
      ts: 1_000,
    });

    const summary = readUsageMonitor({ butlerData, sinceTs: 0 });

    expect(summary.webSearch).toEqual({
      requestCount: 2,
      lastProvider: "new-search",
      lastError: null,
    });
    expect(JSON.stringify(summary)).not.toContain("SECRET_");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
