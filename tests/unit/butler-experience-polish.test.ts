import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runtimeMessages } from "../../packages/butler-agent/src/agent/output/messages.ts";
import {
  applyWebSearchCitationGuard,
  enforceGroundedActionClaims,
  NativeToolLoopRuntime,
} from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import { toTelegramMarkdownV2 } from "../../packages/butler-agent/src/interfaces/transport/telegram/markdown-v2.ts";
import type { ModelProviderAdapter } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

let tempDir = "";

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
  tempDir = mkdtempSync(join(tmpdir(), "butler-experience-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function expectNoInternalLeak(text: string): void {
  expect(text).not.toMatch(/\btask[_ -]?id\b/i);
  expect(text).not.toContain("dispatch_worker");
  expect(text).not.toContain("list_tasks");
  expect(text).not.toContain("get_task_result");
  expect(text).not.toContain("raw prompt");
}

test("normal worker dispatch copy is not owned by runtime fallback strings", () => {
  const ko = runtimeMessages("ko") as unknown as Record<string, unknown>;
  const en = runtimeMessages("en") as unknown as Record<string, unknown>;

  expect(ko.executionPlanFallback).toBeUndefined();
  expect(ko.workerStartHeartbeat).toBeUndefined();
  expect(en.executionPlanFallback).toBeUndefined();
  expect(en.workerStartHeartbeat).toBeUndefined();
});

test("all default progress and guard messages fit mobile transport constraints", () => {
  const messages = [
    runtimeMessages("ko").ungroundedWorkerDispatch(),
    runtimeMessages("ko").ungroundedTaskInspection(),
    runtimeMessages("en").ungroundedWorkerDispatch(),
    runtimeMessages("en").ungroundedTaskInspection(),
  ];

  for (const message of messages) {
    expect(message.length).toBeLessThanOrEqual(220);
    expectNoInternalLeak(message);
  }
});

test("runtime action claim guard does not rewrite through language dictionaries", () => {
  const text = enforceGroundedActionClaims({
    userText: "워커로 확인해줘",
    responseText: "워커를 시작했습니다. 완료되면 보고드리겠습니다.",
    audit: [],
    language: "ko",
  });

  expect(text).toBe("워커를 시작했습니다. 완료되면 보고드리겠습니다.");
  expectNoInternalLeak(text);
});

test("search citation guard keeps sources compact", () => {
  const text = applyWebSearchCitationGuard({
    text: "검색 결과 기준으로 핵심만 정리했습니다.",
    audit: [{
      name: "web_search",
      args: { query: "butler web search" },
      ok: true,
      result: {
        source_urls: [
          "https://example.com/a",
          "https://example.com/b",
          "https://example.com/c",
          "https://example.com/d",
        ],
      },
    }],
  });

  expect(text).toContain("Sources:");
  expect(text.split("\n").filter((line) => line.startsWith("- ["))).toHaveLength(3);
  expect(text.length).toBeLessThanOrEqual(260);
});

test("runtime omits leaked pre-dispatch internals and keeps model heartbeat", async () => {
  const deliveries: string[] = [];
  const progressActions: Array<Record<string, unknown>> = [];
  const runtime = new NativeToolLoopRuntime({
    messageLanguage: "ko",
    disableAutomaticRecall: true,
    executeButlerTool: async () => ({
      ok: true,
      task_id: "task-hidden-from-user",
      status: "RUNNING",
    }),
    runFunctionToolPromptText: async (input) => {
      const internalTask = [
        "task_id: task-hidden-from-user",
        "Inspect fixtures/butler-project/packages/butler-agent/src/agent/turn/native-tool-loop.ts",
        "Inspect fixtures/butler-project/packages/butler-agent/src/agent/work/task-notifications.ts",
        "Return implementation notes, raw evidence, and command transcript.",
      ].join("\n");
      await input.onAssistantTextBeforeTools?.({
        text: internalTask,
        toolCalls: [{
          name: "dispatch_worker",
          args: { task: internalTask },
        }],
      });
      await input.executeTool({
        name: "dispatch_worker",
        args: { task: internalTask },
        rawArguments: JSON.stringify({ task: internalTask }),
      });
      return "시작했습니다. 완료되면 결과만 정리하겠습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/experience",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: {
      eventId: "mock:experience:1",
      accountId: "default",
      transport: "mock",
      peer: { kind: "dm", id: "1" },
      sender: { id: "1" },
      message: {
        id: "experience-1",
        text: "프로젝트 UX 문제를 점검해줘",
        timestamp: new Date().toISOString(),
      },
    },
    emitIntermediateDelivery: async (action) => {
      if (action.metadata?.kind === "tool_progress") {
        progressActions.push(action.metadata);
      }
      const text = action.message.text?.trim();
      if (text) deliveries.push(text);
    },
  });

  expect(deliveries).toHaveLength(0);
  expect(progressActions.filter((action) => action.activityKind !== "model")).toHaveLength(0);
  expect(
    progressActions.filter((action) => action.activityKind === "model"),
  ).toHaveLength(1);
  expect(JSON.stringify(progressActions)).not.toContain("task-hidden-from-user");
  expect(result.text).toBe("시작했습니다. 완료되면 결과만 정리하겠습니다.");
  expectNoInternalLeak(result.text);
});

test("CQ-4 simple questions answer directly without plan or heartbeat ceremony", async () => {
  const deliveries: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    messageLanguage: "ko",
    disableAutomaticRecall: true,
    executeButlerTool: async (call) => {
      throw new Error(`unexpected tool ${call.name}`);
    },
    runFunctionToolPromptText: async () => "정답은 42입니다.",
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/simple-answer",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "정답만 짧게 말해줘" },
    emitIntermediateDelivery: async (action) => {
      deliveries.push(action.message.text ?? "");
    },
  });

  expect(result.text).toBe("정답은 42입니다.");
  expect(deliveries).toEqual([]);
  expect(result.text).not.toContain("작업 계획");
  expect(result.text).not.toContain("착수");
  expectNoInternalLeak(result.text);
});

test("CQ-4 compact source reports remain readable after Telegram MarkdownV2 conversion", () => {
  const report = applyWebSearchCitationGuard({
    text: [
      "확인한 기준으로는 샘플 일정이 오늘 공개되었습니다.",
      "다음 행동은 원문을 기준으로 세부 일정을 확인하는 것입니다.",
    ].join("\n"),
    audit: [{
      name: "web_search",
      args: { query: "샘플 일정" },
      ok: true,
      result: {
        source_urls: [
          "https://example.com/schedule",
          "https://example.com/source-two",
          "https://example.com/source-three",
          "https://example.com/source-four",
        ],
      },
    }],
  });
  const telegramText = toTelegramMarkdownV2(report);

  expect(report.split("\n").filter((line) => line.startsWith("- ["))).toHaveLength(3);
  expect(report.length).toBeLessThanOrEqual(300);
  expect(telegramText).toContain("Sources:");
  expect(telegramText).toContain("https://example\\.com/schedule");
  expect(telegramText).not.toContain("task\\_id");
  expect(telegramText).not.toContain("raw prompt");
});
