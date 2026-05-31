import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type {
  AgentRuntimeAdapter,
  InboundEnvelope,
  ModelProviderAdapter,
  RuntimeSessionHandle,
  RuntimeSessionInit,
  RuntimeTurnInput,
} from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { createLifecycleGatewayHandlers, SessionLifecycleService } from "../../packages/butler-agent/src/interfaces/gateway/session-lifecycle.ts";
import { createGatewayServer } from "../../packages/butler-agent/src/gateways/core/server.ts";
import { GatewayRouter } from "../../packages/butler-agent/src/gateways/core/router.ts";
import { pollWorkerResultsOnce } from "../../packages/butler-agent/src/interfaces/gateway/worker-result-monitor.ts";
import { DeliveryGuard } from "../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts";
import { MockTransportAdapter } from "../../packages/butler-agent/src/interfaces/transport/mock/adapter.ts";
import { NativeToolLoopRuntime } from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import { MockWebSearchProvider } from "../../packages/butler-agent/src/integrations/search/provider.ts";
import { createButlerToolExecutor } from "../../packages/butler-agent/src/agent/tools/butler-tools.ts";

let tempDir = "";
let originalButlerData: string | undefined;

class ScriptedRuntime implements AgentRuntimeAdapter {
  readonly id = "scripted-runtime";
  readonly turns: RuntimeTurnInput[] = [];

  readonly capabilities = {
    supportsSessionResume: false,
    supportsCompaction: false,
    supportsToolStreaming: false,
    supportsParallelToolCalls: false,
  } as const;

  constructor(private readonly reply: string) {}

  async createSession(input: RuntimeSessionInit): Promise<RuntimeSessionHandle> {
    return {
      sessionId: input.sessionId,
      role: input.role,
      runtimeAdapterId: this.id,
      runtimeSessionRef: `scripted:${input.sessionId}`,
    };
  }

  async runTurn(input: RuntimeTurnInput) {
    this.turns.push(input);
    return {
      text: this.reply,
      runtimeSessionRef: input.handle.runtimeSessionRef,
    };
  }

  async closeSession() {}
}

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

function mockInbound(text: string): InboundEnvelope {
  return {
    eventId: `mock:event:${Date.now()}`,
    transport: "mock",
    accountId: "default",
    peer: { kind: "dm", id: "peer-1" },
    sender: { id: "user-1", displayName: "Local Tester" },
    message: {
      id: `msg-${Date.now()}`,
      text,
      timestamp: new Date().toISOString(),
    },
  };
}

function createWebSearchExecutor(butlerData: string) {
  return createButlerToolExecutor({
    butlerHome: "fixtures/butler-project",
    butlerData,
    webSearchProvider: new MockWebSearchProvider([{
      title: "Butler Search Result",
      url: "https://example.com/butler-search",
      snippet: "A source-backed mock web search result.",
      source: "example.com",
    }]),
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-transport-agnostic-"));
  originalButlerData = process.env.BUTLER_DATA;
  process.env.BUTLER_DATA = tempDir;
});

afterEach(() => {
  if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalButlerData;
  rmSync(tempDir, { recursive: true, force: true });
});

test("mock transport can drive a full Butler conversation without Telegram", async () => {
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const runtime = new ScriptedRuntime("mock runtime reply");
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

  const router = new GatewayRouter({ store });
  const lifecycle = new SessionLifecycleService({
    store,
    runtime,
    provider: fakeProvider,
    systemPromptFactory: () => "You are Butler in a transport-agnostic test.",
    deliverIntermediate: async ({ binding, action, metadata }) => {
      await guard.deliver(binding.sessionId, action, metadata);
    },
  });
  const server = createGatewayServer({
    router,
    handlers: createLifecycleGatewayHandlers(lifecycle),
  });
  const mock = new MockTransportAdapter({ id: "mock" });
  const guard = new DeliveryGuard({ adapters: [mock] });

  await mock.start(async (event) => {
    const result = await server.handleInbound(event);
    expect(result.status).toBe("handled");
    if (result.status !== "handled") return;
    const text = result.handlerResult.metadata?.text;
    if (typeof text !== "string") return;
    await guard.deliver(result.route.sessionId, {
      actionId: `mock-reply:${event.message.id}`,
      transport: "mock",
      accountId: event.accountId,
      peer: event.peer,
      message: {
        text,
        replyToMessageId: event.message.id,
      },
      metadata: {
        source: "transport-agnostic-conversation.test.ts",
      },
    });
  });

  await mock.emit(mockInbound("Telegram 없이 대화 테스트"));

  expect(runtime.turns).toHaveLength(1);
  expect(runtime.turns[0]!.input).toMatchObject({
    transport: "mock",
    message: { text: "Telegram 없이 대화 테스트" },
  });
  expect(mock.sentActions).toHaveLength(2);
  expect(mock.sentActions[0]).toMatchObject({
    transport: "mock",
    presence: { kind: "typing" },
  });
  expect(mock.sentActions[1]).toMatchObject({
    transport: "mock",
    message: { text: "mock runtime reply" },
  });
});

test("worker completion can be delivered through mock transport without Telegram", async () => {
  const taskDir = join(tempDir, "tasks", "task-mock");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "DONE\n", "utf8");
  writeFileSync(join(taskDir, "request.md"), "run mock worker\n", "utf8");
  writeFileSync(join(taskDir, "result.md"), "mock worker result\n", "utf8");

  const mock = new MockTransportAdapter({ id: "mock" });
  const guard = new DeliveryGuard({ adapters: [mock] });
  const delivered = await pollWorkerResultsOnce({
    butlerHome: "fixtures/butler-project",
    butlerData: tempDir,
    sessionId: "butler/main",
    deliveryTarget: {
      transport: "mock",
      accountId: "default",
      peerKind: "dm",
      peerId: "peer-1",
    },
    renderNotificationText: async () => "Worker report\nResult: mock worker result",
    deliverAction: async (sessionId, action, metadata) =>
      await guard.deliver(sessionId, action, metadata),
  });

  expect(delivered).toBe(1);
  expect(mock.sentActions).toHaveLength(1);
  expect(mock.sentActions[0]).toMatchObject({
    transport: "mock",
    peer: { kind: "dm", id: "peer-1" },
  });
  expect(mock.sentActions[0]!.message.text).toContain("Worker report");
  expect(mock.sentActions[0]!.message.text).toContain("mock worker result");
});

test("mock transport reliability harness retries failed worker completion delivery", async () => {
  const taskDir = join(tempDir, "tasks", "task-mock-retry");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "DONE\n", "utf8");
  writeFileSync(join(taskDir, "request.md"), "run retryable mock worker\n", "utf8");
  writeFileSync(join(taskDir, "result.md"), "retryable mock worker result\n", "utf8");

  let sendAttempts = 0;
  const mock = new MockTransportAdapter({
    id: "mock",
    onSend: () => {
      sendAttempts += 1;
      return sendAttempts === 1
        ? { ok: false, error: "mock transport unavailable" }
        : { ok: true, transportMessageId: `mock:${sendAttempts}` };
    },
  });
  const guard = new DeliveryGuard({ adapters: [mock] });
  const deliveryTarget = {
    transport: "mock",
    accountId: "default",
    peerKind: "dm" as const,
    peerId: "peer-1",
  };
  const deliverAction = async (
    sessionId: string,
    action: Parameters<DeliveryGuard["deliver"]>[1],
    metadata: Record<string, unknown>,
  ) => await guard.deliver(sessionId, action, metadata);

  const first = await pollWorkerResultsOnce({
    butlerHome: "fixtures/butler-project",
    butlerData: tempDir,
    sessionId: "butler/main",
    deliveryTarget,
    renderNotificationText: async () => "Retryable worker report",
    deliverAction,
  });
  const second = await pollWorkerResultsOnce({
    butlerHome: "fixtures/butler-project",
    butlerData: tempDir,
    sessionId: "butler/main",
    deliveryTarget,
    renderNotificationText: async () => "Retryable worker report",
    deliverAction,
  });
  const third = await pollWorkerResultsOnce({
    butlerHome: "fixtures/butler-project",
    butlerData: tempDir,
    sessionId: "butler/main",
    deliveryTarget,
    renderNotificationText: async () => "must not redeliver",
    deliverAction,
  });

  expect(first).toBe(0);
  expect(second).toBe(1);
  expect(third).toBe(0);
  expect(sendAttempts).toBe(2);
  expect(mock.sentActions).toHaveLength(2);
  expect(mock.sentActions[1]!.message.text).toBe("Retryable worker report");
});

test("mock transport can deliver a source-backed web search answer without Telegram", async () => {
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const runtime = new NativeToolLoopRuntime({
    executeButlerTool: createWebSearchExecutor(tempDir),
    runFunctionToolPromptText: async (input) => {
      await input.executeTool({
        name: "web_search",
        args: { query: "Butler web search docs" },
        rawArguments: "{\"query\":\"Butler web search docs\"}",
      });
      return "I found the relevant current reference.";
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

  const router = new GatewayRouter({ store });
  const lifecycle = new SessionLifecycleService({
    store,
    runtime,
    provider: fakeProvider,
    systemPromptFactory: () => "You are Butler in a transport-agnostic test.",
    deliverIntermediate: async ({ binding, action, metadata }) => {
      await guard.deliver(binding.sessionId, action, metadata);
    },
  });
  const server = createGatewayServer({
    router,
    handlers: createLifecycleGatewayHandlers(lifecycle),
  });
  const mock = new MockTransportAdapter({ id: "mock" });
  const guard = new DeliveryGuard({ adapters: [mock] });

  await mock.start(async (event) => {
    const result = await server.handleInbound(event);
    expect(result.status).toBe("handled");
    if (result.status !== "handled") return;
    const text = result.handlerResult.metadata?.text;
    if (typeof text !== "string") return;
    await guard.deliver(result.route.sessionId, {
      actionId: `mock-reply:${event.message.id}`,
      transport: "mock",
      accountId: event.accountId,
      peer: event.peer,
      message: { text },
    });
  });

  await mock.emit(mockInbound("최신 자료를 찾아서 답해줘"));

  expect(mock.sentActions.at(-1)?.message.text).toContain("Sources:");
  expect(mock.sentActions.at(-1)?.message.text).toContain("https://example.com/butler-search");
});

test("mock transport can drive recall context into native runtime without Telegram", async () => {
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  let capturedPrompt = "";
  const runtime = new NativeToolLoopRuntime({
    recallMemory: () => ({
      cue: "떡볶이 먹고 싶다",
      seeds: ["떡볶이"],
      abstained: false,
      diagnostics: ["fixture"],
      items: [{
        summary: "지난번 로제 떡볶이 선택과 최근 저탄수 목표가 함께 관련된다.",
        confidence: 0.84,
        source: "hybrid",
        originalSource: "graph",
        provenance: ["graph:food"],
        related_nodes: ["tteokbokki", "low-carb-goal"],
        score_breakdown: {
          semantic_similarity: 0.8,
          graph_activation: 0.8,
          recency_score: 0.4,
          frequency_score: 0.2,
          explicit_salience: 0,
          decision_preference_boost: 0.18,
          hub_penalty: 0,
          conflict_penalty: 0,
          stale_superseded_penalty: 0,
          total: 0.84,
        },
      }],
    }),
    runFunctionToolPromptText: async (input) => {
      capturedPrompt = input.prompt;
      return "지난번 취향과 현재 목표를 함께 고려하겠습니다.";
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

  const router = new GatewayRouter({ store });
  const lifecycle = new SessionLifecycleService({
    store,
    runtime,
    provider: fakeProvider,
    systemPromptFactory: () => "You are Butler in a transport-agnostic recall test.",
  });
  const server = createGatewayServer({
    router,
    handlers: createLifecycleGatewayHandlers(lifecycle),
  });
  const mock = new MockTransportAdapter({ id: "mock" });
  const guard = new DeliveryGuard({ adapters: [mock] });

  await mock.start(async (event) => {
    const result = await server.handleInbound(event);
    expect(result.status).toBe("handled");
    if (result.status !== "handled") return;
    const text = result.handlerResult.metadata?.text;
    if (typeof text !== "string") return;
    await guard.deliver(result.route.sessionId, {
      actionId: `mock-recall-reply:${event.message.id}`,
      transport: "mock",
      accountId: event.accountId,
      peer: event.peer,
      message: { text },
    });
  });

  await mock.emit(mockInbound("떡볶이 먹고 싶다"));

  expect(capturedPrompt).toContain("## Associative Recall Context");
  expect(capturedPrompt).toContain("로제 떡볶이");
  expect(mock.sentActions.at(-1)?.message.text).toContain("현재 목표");
});

test("worker completion reports topic A origin while topic B conversation remains active", async () => {
  const taskDir = join(tempDir, "tasks", "task-topic-a");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "DONE\n", "utf8");
  writeFileSync(join(taskDir, "request.md"), "generate topic A chart\n", "utf8");
  writeFileSync(join(taskDir, "result.md"), "topic A chart is ready\n", "utf8");
  writeFileSync(join(taskDir, "origin.json"), `${JSON.stringify({
    version: 1,
    origin_session_id: "butler/main",
    origin_message_id: "a-1",
    origin_inbound_event_id: "mock:a-1",
    task_summary: "Topic A chart generation",
    created_at: "2026-04-25T00:00:00.000Z",
    project: "fixtures/butler-project",
    topic_summary: "Topic A",
    transcript_ref: {
      session_id: "butler/main",
      path: join(tempDir, "transcripts", "butler_main.jsonl"),
      origin_event_id: "mock:a-1",
      origin_message_id: "a-1",
      recent_event_ids: ["mock:a-1"],
    },
    memory_refs: [],
  }, null, 2)}\n`, "utf8");

  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const runtime = new ScriptedRuntime("B 주제 대화는 계속 활성 상태입니다.");
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

  const router = new GatewayRouter({ store });
  const lifecycle = new SessionLifecycleService({
    store,
    runtime,
    provider: fakeProvider,
    systemPromptFactory: () => "You are Butler in a transport-agnostic test.",
    deliverIntermediate: async ({ binding, action, metadata }) => {
      await guard.deliver(binding.sessionId, action, metadata);
    },
  });
  const server = createGatewayServer({
    router,
    handlers: createLifecycleGatewayHandlers(lifecycle),
  });
  const mock = new MockTransportAdapter({ id: "mock" });
  const guard = new DeliveryGuard({ adapters: [mock] });

  await mock.start(async (event) => {
    const result = await server.handleInbound(event);
    expect(result.status).toBe("handled");
    if (result.status !== "handled") return;
    const text = result.handlerResult.metadata?.text;
    if (typeof text !== "string") return;
    await guard.deliver(result.route.sessionId, {
      actionId: `mock-reply:${event.message.id}`,
      transport: "mock",
      accountId: event.accountId,
      peer: event.peer,
      message: {
        text,
        replyToMessageId: event.message.id,
      },
    });
  });

  await mock.emit(mockInbound("이제 B 주제로 이야기하자"));
  const delivered = await pollWorkerResultsOnce({
    butlerHome: "fixtures/butler-project",
    butlerData: tempDir,
    sessionId: "butler/main",
    deliveryTarget: {
      transport: "mock",
      accountId: "default",
      peerKind: "dm",
      peerId: "peer-1",
    },
    renderNotificationText: async () => "Topic A completion report\nThe chart is ready.",
    deliverAction: async (sessionId, action, metadata) =>
      await guard.deliver(sessionId, action, metadata),
  });

  expect(delivered).toBe(1);
  expect(runtime.turns).toHaveLength(1);
  expect(mock.sentActions).toHaveLength(3);
  expect(mock.sentActions[0]!.presence).toMatchObject({ kind: "typing" });
  expect(mock.sentActions[1]!.message.text).toContain("B 주제 대화");
  expect(mock.sentActions[2]!.message.text).toContain("Topic A completion report");
  expect(mock.sentActions[2]!.message.text).not.toContain("origin:");
});
