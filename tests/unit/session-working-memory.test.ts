import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ModelProviderAdapter } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import {
  appendTranscriptEvent,
  createTranscriptEvent,
} from "../../packages/butler-agent/src/test-support/harness/transcripts.ts";
import {
  extractWorkingMemoryFacts,
  refreshWorkingMemoryFromTranscript,
  readWorkingMemoryDiagnostics,
  readWorkingMemorySnapshot,
  workingMemoryPath,
} from "../../packages/butler-agent/src/agent/context/working-memory.ts";
import { NativeToolLoopRuntime } from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";

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
  tempDir = mkdtempSync(join(tmpdir(), "butler-session-working-memory-"));
  originalButlerData = process.env.BUTLER_DATA;
  process.env.BUTLER_DATA = tempDir;
});

afterEach(() => {
  if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalButlerData;
  rmSync(tempDir, { recursive: true, force: true });
});

function appendUser(eventId: string, messageId: string, text: string): void {
  appendTranscriptEvent(createTranscriptEvent({
    sessionId: "butler/main",
    eventId,
    kind: "inbound",
    timestamp: `2026-04-28T11:${messageId.padStart(2, "0")}:00.000Z`,
    payload: {
      eventId,
      message: {
        id: messageId,
        text,
      },
    },
    transport: "telegram",
  }));
}

function appendUserToSession(sessionId: string, eventId: string, messageId: string, text: string): void {
  appendTranscriptEvent(createTranscriptEvent({
    sessionId,
    eventId,
    kind: "inbound",
    timestamp: `2026-04-28T12:${messageId.padStart(2, "0")}:00.000Z`,
    payload: {
      eventId,
      message: {
        id: messageId,
        text,
      },
    },
    transport: "mock",
  }));
}

function appendButler(eventId: string, text: string): void {
  appendTranscriptEvent(createTranscriptEvent({
    sessionId: "butler/main",
    eventId,
    kind: "outbound",
    payload: {
      message: { text },
    },
    transport: "telegram",
  }));
}

test("working memory does not extract active-session facts with language heuristics", () => {
  const facts = extractWorkingMemoryFacts(
    "테스트 입력: 항목D,항목E,항목F,항목G 상태확정... 항목A2단계,항목H,항목I,항목J 상태확정... 항목C는 선호 항목이야",
  ).map((fact) => `${fact.category}:${fact.text}`);

  expect(facts).toEqual([]);
});

test("working memory leaves negated and positive prose to model-owned memory tools", () => {
  const facts = extractWorkingMemoryFacts("항목D는 상태확정이 아니야. 항목A2단계은 맞아.")
    .map((fact) => `${fact.category}:${fact.text}`);

  expect(facts).toEqual([]);
});

test("runtime does not inject heuristic working memory before model-owned memory tools", async () => {
  appendUser(
    "telegram:1000000001:main:1640",
    "1640",
    "테스트 입력: 항목D,항목E,항목F,항목G 상태확정... 항목A2단계,항목H,항목I,항목J 상태확정... 항목K 상태확정,항목L 기본,항목M 상태확정,항목N 기본.",
  );
  appendButler(
    "reply:1640",
    `긴 답변입니다. ${"계정 분석과 파티 추천을 계속 설명합니다. ".repeat(120)}`,
  );

  for (let index = 0; index < 12; index += 1) {
    appendUser(`telegram:1000000001:main:filler-${index}`, `f${index}`, `다른 주제 ${index}`);
    appendButler(
      `reply:filler-${index}`,
      `긴 후속 답변 ${index}. ${"이 답변은 최근 대화 suffix를 밀어내기 위한 내용입니다. ".repeat(80)}`,
    );
  }

  appendUser(
    "telegram:1000000001:main:1669",
    "1669",
    "항목A 몇 단계이라고?",
  );

  let capturedPrompt = "";
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    recentConversationTokenBudget: 320,
    runFunctionToolPromptText: async (input) => {
      capturedPrompt = input.prompt;
      return "항목A는 2단계입니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      eventId: "telegram:1000000001:main:1669",
      accountId: "default",
      transport: "telegram",
      peer: { kind: "dm", id: "1000000001" },
      sender: { id: "1000000001", displayName: "@example_user" },
      message: {
        id: "1669",
        text: "항목A 몇 단계이라고?",
        timestamp: "2026-04-28T11:36:09.000Z",
      },
    },
  });

  const recentConversation = capturedPrompt.split("## Recent Conversation")[1]?.split("## Inbound Message")[0] ?? "";
  const snapshot = readWorkingMemorySnapshot({
    butlerData: tempDir,
    sessionId: "butler/main",
  });

  expect(result.text).toBe("항목A는 2단계입니다.");
  expect(capturedPrompt).not.toContain("## Working Memory");
  expect(capturedPrompt).not.toContain("항목A: 2단계");
  expect(capturedPrompt).not.toContain("항목D: 상태확정");
  expect(recentConversation).not.toContain("항목A2단계");
  expect(snapshot?.facts).toEqual([]);
});

test("working memory write failures do not block prompt-time continuity", () => {
  appendUser("telegram:1000000001:main:2001", "2001", "항목A2단계이고 항목C는 선호 항목이야");
  const blockedDataDir = join(tempDir, "blocked");
  mkdirSync(blockedDataDir, { recursive: true });
  writeFileSync(join(blockedDataDir, "context"), "not a directory", "utf8");

  const snapshot = refreshWorkingMemoryFromTranscript({
    butlerData: blockedDataDir,
    sessionId: "butler/main",
  });

  expect(snapshot.facts).toEqual([]);
});

test("working memory refresh does not supersede facts from prose heuristics", () => {
  appendUser("telegram:1000000001:main:3001", "3001", "항목A1단계이고 항목C는 선호 항목이야");
  appendUser("telegram:1000000001:main:3002", "3002", "아까 말한 항목A는 정정해서 항목A2단계이야");

  const snapshot = refreshWorkingMemoryFromTranscript({
    butlerData: tempDir,
    sessionId: "butler/main",
  });

  expect(snapshot.facts).toEqual([]);
});

test("working memory bounds overflow and reports raw-text-free diagnostics", () => {
  for (let index = 0; index < 100; index += 1) {
    appendUser(
      `telegram:1000000001:main:overflow-${index}`,
      `o${index}`,
      `캐릭터${index} ${index % 7}돌`,
    );
  }

  const snapshot = refreshWorkingMemoryFromTranscript({
    butlerData: tempDir,
    sessionId: "butler/main",
  });
  const diagnostics = readWorkingMemoryDiagnostics({
    butlerData: tempDir,
    sessionId: "butler/main",
  });

  expect(snapshot.facts).toHaveLength(0);
  expect(diagnostics).toMatchObject({
    exists: true,
    parseStatus: "ok",
    factCount: 0,
  });
  expect(JSON.stringify(diagnostics)).not.toContain("캐릭터");
  expect(diagnostics.renderedCharCount).toBe(0);
});

test("working memory diagnostics tolerate malformed ledgers without exposing text", () => {
  mkdirSync(join(tempDir, "context", "working-memory"), { recursive: true });
  writeFileSync(workingMemoryPath({
    butlerData: tempDir,
    sessionId: "butler/main",
  }), "{ this is not json and SECRET_FACT should not escape", "utf8");

  const diagnostics = readWorkingMemoryDiagnostics({
    butlerData: tempDir,
    sessionId: "butler/main",
  });

  expect(diagnostics).toMatchObject({
    exists: true,
    parseStatus: "malformed",
    factCount: 0,
    renderedCharCount: 0,
    updatedAt: null,
  });
  expect(JSON.stringify(diagnostics)).not.toContain("SECRET_FACT");
});

test("working memory keeps concurrent sessions isolated", () => {
  appendUserToSession("butler/main", "mock:main:4001", "01", "항목A2단계이야");
  appendUserToSession("steward/project-a", "mock:project-a:4001", "01", "항목D 상태확정이야");

  const main = refreshWorkingMemoryFromTranscript({
    butlerData: tempDir,
    sessionId: "butler/main",
  });
  const steward = refreshWorkingMemoryFromTranscript({
    butlerData: tempDir,
    sessionId: "steward/project-a",
  });

  expect(main.facts).toEqual([]);
  expect(steward.facts).toEqual([]);
});
