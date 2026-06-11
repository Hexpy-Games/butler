import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createGatewayServer } from "../../packages/butler-agent/src/gateways/core/server.ts";
import { createLifecycleGatewayHandlers, SessionLifecycleService } from "../../packages/butler-agent/src/interfaces/gateway/session-lifecycle.ts";
import { GatewayRouter } from "../../packages/butler-agent/src/gateways/core/router.ts";
import type { ModelProviderAdapter } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { NativeToolLoopRuntime } from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import { DeliveryGuard } from "../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts";
import { MockTransportAdapter } from "../../packages/butler-agent/src/interfaces/transport/mock/adapter.ts";

let tempDir = "";
let originalButlerData: string | undefined;

const fakeProvider: ModelProviderAdapter = {
  id: "fake-provider",
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
  tempDir = mkdtempSync(join(tmpdir(), "butler-native-conversation-"));
  originalButlerData = process.env.BUTLER_DATA;
  process.env.BUTLER_DATA = tempDir;
});

afterEach(() => {
  if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalButlerData;
  rmSync(tempDir, { recursive: true, force: true });
});

test("mock transport drives NativeToolLoopRuntime through dispatch_worker and execution-plan delivery", async () => {
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const runtime = new NativeToolLoopRuntime({
    butlerHome: tempDir,
    butlerData: tempDir,
    messageLanguage: "ko",
    executeButlerTool: async (call) => {
      expect(call.name).toBe("dispatch_worker");
      const taskDir = join(tempDir, "tasks", "task-real-runtime-harness");
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "status"), "RUNNING\n", "utf8");
      writeFileSync(join(taskDir, "request.md"), String(call.args.task), "utf8");
      return {
        ok: true,
        task_id: "task-real-runtime-harness",
        status: "RUNNING",
      };
    },
    runFunctionToolPromptText: async (input) => {
      await input.onAssistantTextBeforeTools?.({
        text: "A 주제 차트 작업은 백그라운드에서 진행하겠습니다. 완료되면 생성 결과와 확인한 내용을 짧게 보고드리겠습니다.",
        toolCalls: [{
          name: "dispatch_worker",
          args: {
            task: "Topic A chart generation",
            project_path: "fixtures/butler-project",
          },
        }],
      });
      await input.executeTool({
        name: "dispatch_worker",
        args: {
          task: "Topic A chart generation",
          project_path: "fixtures/butler-project",
        },
        rawArguments: "{\"task\":\"Topic A chart generation\",\"project_path\":\"fixtures/butler-project\"}",
      });
      return "실행을 시작했습니다. 완료되면 생성 결과와 확인한 내용을 짧게 보고드리겠습니다.";
    },
  });
  store.upsert({
    sessionId: "butler/main",
    role: "butler",
    projectId: "butler",
    workspacePath: "fixtures/butler-project",
    runtimeAdapterId: runtime.id,
    modelProviderId: fakeProvider.id,
    modelRef: "openai/auto:codex-latest",
    transportBindings: [{
      transport: "mock",
      accountId: "default",
      peerId: "peer-1",
    }],
  });

  const mock = new MockTransportAdapter({ id: "mock" });
  const guard = new DeliveryGuard({ adapters: [mock] });
  const router = new GatewayRouter({ store });
  const lifecycle = new SessionLifecycleService({
    store,
    runtime,
    provider: fakeProvider,
    systemPromptFactory: () => "You are Butler in a native runtime harness.",
    deliverIntermediate: async ({ binding, action, metadata }) => {
      await guard.deliver(binding.sessionId, action, metadata);
    },
  });
  const server = createGatewayServer({
    router,
    handlers: createLifecycleGatewayHandlers(lifecycle),
  });

  await mock.start(async (event) => {
    const result = await server.handleInbound(event);
    expect(result.status).toBe("handled");
    if (result.status !== "handled") return;
    const text = result.handlerResult.metadata?.text;
    if (typeof text !== "string") return;
    await guard.deliver(result.route.sessionId, {
      actionId: `mock-final:${event.message.id}`,
      transport: "mock",
      accountId: event.accountId,
      peer: event.peer,
      message: {
        text,
        replyToMessageId: event.message.id,
      },
    });
  });

  await mock.emit({
    eventId: "mock:topic-a:1",
    transport: "mock",
    accountId: "default",
    peer: { kind: "dm", id: "peer-1" },
    sender: { id: "user-1", displayName: "Local Tester" },
    message: {
      id: "topic-a-1",
      text: "A 주제 차트는 워커로 처리해주세요",
      timestamp: new Date().toISOString(),
    },
  });

  const visibleActions = mock.sentActions.filter((action) => action.message.text?.trim());
  const progressActions = mock.sentActions.filter((action) => action.metadata?.kind === "tool_progress");
  const dispatchProgressActions = progressActions.filter((action) => action.metadata?.activityKind !== "model");
  expect(mock.sentActions).toHaveLength(5);
  expect(visibleActions).toHaveLength(2);
  expect(dispatchProgressActions).toHaveLength(1);
  expect(dispatchProgressActions[0]!.message.text).toBe("");
  expect(mock.sentActions[0]!.presence).toMatchObject({ kind: "typing" });
  expect(visibleActions[0]!.message.text).toContain("A 주제 차트 작업은 백그라운드에서 진행하겠습니다");
  expect(visibleActions[0]!.message.text).not.toContain("워커");
  expect(visibleActions[0]!.message.text).not.toContain("Topic A chart generation");
  expect(visibleActions[1]!.message.text).toBe("실행을 시작했습니다. 완료되면 생성 결과와 확인한 내용을 짧게 보고드리겠습니다.");
  expect(visibleActions[1]!.message.text).not.toContain("백그라운드에서 진행 중입니다");
  const visibleText = mock.sentActions.map((action) => action.message.text ?? "").join("\n");
  expect(visibleText).not.toContain("워커 디스패치");
  expect(visibleText).not.toContain("task-real-runtime-harness");

  const originPath = join(tempDir, "tasks", "task-real-runtime-harness", "origin.json");
  expect(existsSync(originPath)).toBe(true);
  const origin = JSON.parse(readFileSync(originPath, "utf8"));
  expect(origin).toMatchObject({
    origin_session_id: "butler/main",
    origin_message_id: "topic-a-1",
    origin_inbound_event_id: "mock:topic-a:1",
    task_summary: "Topic A chart generation",
  });
});
