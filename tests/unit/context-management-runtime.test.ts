import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  appendTranscriptEvent,
  createTranscriptEvent,
  readTranscript,
} from "../../packages/butler-agent/src/test-support/harness/transcripts.ts";
import { PromptAssembler } from "../../packages/butler-agent/src/agent/prompt/prompt-assembler.ts";
import type { StoredSessionBinding, ModelProviderAdapter } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import { readContextMetrics } from "../../packages/butler-agent/src/operations/metrics/context-monitor.ts";
import { NativeToolLoopRuntime } from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import { estimateContextTokens } from "../../packages/butler-agent/src/agent/context/budget.ts";
import { budgetToolOutput } from "../../packages/butler-agent/src/agent/context/tool-output-budgeter.ts";

let tempDir = "";
let originalButlerData: string | undefined;

const fakeProvider: ModelProviderAdapter = {
  id: "fake-openai",
  capabilities: {
    supportsStreaming: false,
    supportsToolCalls: true,
    supportsImages: false,
    supportsAudio: false,
    supportsServerThreads: false,
    supportsReasoningConfig: true,
    supportsPromptCaching: true,
  },
  async invoke() {
    return { text: "unused" };
  },
};

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-context-runtime-"));
  originalButlerData = process.env.BUTLER_DATA;
  process.env.BUTLER_DATA = tempDir;
});

afterEach(() => {
  if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalButlerData;
  rmSync(tempDir, { recursive: true, force: true });
});

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

function writePromptFixture(root: string): {
  butlerHome: string;
  butlerData: string;
} {
  const butlerHome = join(root, "home");
  const butlerData = tempDir;
  mkdirSync(join(butlerHome, "resources", "prompts"), { recursive: true });
  mkdirSync(join(butlerHome, "resources", "skills"), { recursive: true });
  mkdirSync(join(butlerData, "cognition", "memory", "hot"), { recursive: true });
  mkdirSync(join(butlerData, "personas"), { recursive: true });

  writeFileSync(join(butlerHome, "resources", "prompts", "runtime-system-contract.md"), "RUNTIME_CONTRACT_STABLE", "utf8");
  writeFileSync(join(butlerHome, "resources", "prompts", "butler.md"), "ROLE_STABLE", "utf8");
  writeFileSync(join(butlerData, "personas", "active.md"), "PERSONA_STABLE", "utf8");
  writeFileSync(join(butlerData, "cognition", "memory", "hot", "cache.md"), "HOT_DYNAMIC_V1", "utf8");
  return { butlerHome, butlerData };
}

function appendLongTranscript(turns: number): void {
  for (let index = 0; index < turns; index += 1) {
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: "butler/main",
      eventId: `long-u-${index}`,
      kind: "inbound",
      payload: {
        message: {
          text: `A주제 결정 ${index}: 이전 맥락을 유지해야 합니다. ${"상세 ".repeat(80)}`,
        },
      },
    }));
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: "butler/main",
      eventId: `long-a-${index}`,
      kind: "outbound",
      payload: {
        message: {
          text: `보고 ${index}: 나중에 요약과 회상으로 복구되어야 합니다. ${"응답 ".repeat(80)}`,
        },
      },
    }));
  }
}

function legacyRecentConversationTokens(): number {
  const lines = readTranscript("butler/main")
    .map((event) => {
      const payload = event.payload as Record<string, any>;
      const text = payload.message?.text;
      if (typeof text !== "string") return null;
      return `${event.kind === "inbound" ? "user" : "butler"}: ${text}`;
    })
    .filter((line): line is string => Boolean(line))
    .slice(-12);
  return estimateContextTokens(["## Recent Conversation", ...lines].join("\n"));
}

test("prompt assembler keeps hot cache out of stable prefix while preserving dynamic context", () => {
  const { butlerHome, butlerData } = writePromptFixture(tempDir);
  const assembler = new PromptAssembler({ butlerHome, butlerData });
  const session = binding(butlerHome);
  const first = assembler.buildSystemPrompt(session);
  const firstMetric = readContextMetrics({ butlerData, sessionId: "butler/main" }).at(-1) as any;

  expect(first.systemPrompt).toContain("RUNTIME_CONTRACT_STABLE");
  expect(first.systemPrompt).not.toContain("HOT_DYNAMIC_V1");
  expect(typeof firstMetric.stablePrefixHash).toBe("string");

  writeFileSync(join(butlerData, "cognition", "memory", "hot", "cache.md"), "HOT_DYNAMIC_V2", "utf8");
  const second = assembler.buildSystemPrompt(session);
  const secondMetric = readContextMetrics({ butlerData, sessionId: "butler/main" }).at(-1) as any;
  expect(second.systemPrompt).not.toContain("HOT_DYNAMIC_V2");
  expect(secondMetric.stablePrefixHash).toBe(firstMetric.stablePrefixHash);

  const turnContext = assembler.buildTurnContext({
    binding: session,
    envelope: {
      eventId: "mock:1",
      transport: "mock",
      accountId: "default",
      peer: { kind: "dm", id: "1" },
      sender: { id: "1" },
      message: {
        id: "m1",
        text: "hello",
        timestamp: new Date().toISOString(),
      },
    },
  });
  expect(turnContext).toContain("HOT_DYNAMIC_V2");
});

test("runtime compacts long transcript and reduces recent-context prompt tokens", async () => {
  appendLongTranscript(24);
  const legacyRecentTokens = legacyRecentConversationTokens();
  let capturedPrompt = "";
  const runtime = new NativeToolLoopRuntime({
    contextBudgetOverrides: {
      contextWindowTokens: 1_600,
      reservedOutputTokens: 50,
      reservedToolTokens: 50,
    },
    recentConversationTokenBudget: 220,
    runFunctionToolPromptText: async (input) => {
      capturedPrompt = input.prompt;
      return "요약 기반으로 이어가겠습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/test",
    input: { text: "A주제에서 마지막 결정이 뭐였는지 이어서 알려줘" },
  });

  const promptTokens = estimateContextTokens(capturedPrompt);
  const recentSection = capturedPrompt.split("## Recent Conversation")[1]?.split("## Associative Recall Context")[0] ?? "";
  const newRecentTokens = estimateContextTokens(recentSection);

  expect(capturedPrompt).toContain("## Compaction Summary");
  expect(capturedPrompt).toContain("## Recent Conversation");
  expect(newRecentTokens).toBeLessThanOrEqual(230);
  expect(newRecentTokens).toBeLessThan(legacyRecentTokens);
  expect(promptTokens).toBeLessThan(legacyRecentTokens + 1_000);
});

test("context management benchmark records measurable before-after efficiency", () => {
  appendLongTranscript(30);
  const legacyRecentTokens = legacyRecentConversationTokens();
  const compactTool = budgetToolOutput({
    butlerData: tempDir,
    maxModelTokens: 300,
    result: {
      stdout: Array.from({ length: 300 }, (_, index) => `benchmark ${index} ${"x".repeat(100)}`).join("\n"),
      stderr: "",
      exit_code: 0,
      timed_out: false,
    },
  });
  const rawToolTokens = compactTool.butler_tool_artifact?.raw_tokens ?? 0;
  const compactToolTokens = compactTool.butler_tool_artifact?.compact_tokens ?? rawToolTokens;

  const metrics = {
    legacyRecentTokens,
    targetRecentTokens: 220,
    recentReductionRatio: 1 - (220 / legacyRecentTokens),
    rawToolTokens,
    compactToolTokens,
    toolReductionRatio: rawToolTokens > 0 ? 1 - (compactToolTokens / rawToolTokens) : 0,
  };

  expect(metrics.legacyRecentTokens).toBeGreaterThan(700);
  expect(metrics.recentReductionRatio).toBeGreaterThan(0.70);
  expect(metrics.rawToolTokens).toBeGreaterThan(5_000);
  expect(metrics.toolReductionRatio).toBeGreaterThan(0.80);
});
