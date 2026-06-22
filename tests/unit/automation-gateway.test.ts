import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type {
  AgentRuntimeAdapter,
  ArtifactRef,
  InboundEnvelope,
  ModelProviderAdapter,
  RuntimeSessionHandle,
  RuntimeSessionInit,
  RuntimeTurnInput,
} from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { GatewayRouter } from "../../packages/butler-agent/src/gateways/core/router.ts";
import { createGatewayServer } from "../../packages/butler-agent/src/gateways/core/server.ts";
import { createLifecycleGatewayHandlers, SessionLifecycleService } from "../../packages/butler-agent/src/interfaces/gateway/session-lifecycle.ts";
import { AutomationStore } from "../../packages/butler-agent/src/operations/service/automation-store.ts";
import { NativeInboundQueue } from "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";
import {
  processQueuedInboundEvents,
  QueuedInboundDispatcher,
} from "../../packages/butler-agent/src/interfaces/gateway/queued-inbound.ts";
import { DeliveryGuard } from "../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts";
import { MockTransportAdapter } from "../../packages/butler-agent/src/interfaces/transport/mock/adapter.ts";
import { ModelProviderRequestError } from "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";

let tempDir = "";
let originalButlerData: string | undefined;

class ScriptedRuntime implements AgentRuntimeAdapter {
  readonly id = "automation-runtime";
  readonly turns: RuntimeTurnInput[] = [];
  readonly capabilities = {
    supportsSessionResume: false,
    supportsCompaction: false,
    supportsToolStreaming: false,
    supportsParallelToolCalls: false,
  } as const;

  constructor(private readonly artifacts: ArtifactRef[] = []) {}

  async createSession(input: RuntimeSessionInit): Promise<RuntimeSessionHandle> {
    return {
      sessionId: input.sessionId,
      role: input.role,
      runtimeAdapterId: this.id,
      runtimeSessionRef: `automation:${input.sessionId}`,
    };
  }

  async runTurn(input: RuntimeTurnInput) {
    this.turns.push(input);
    return {
      text: "automation handled",
      artifacts: this.artifacts,
      runtimeSessionRef: input.handle.runtimeSessionRef,
    };
  }
}

class PersistenceFailingInboundQueue extends NativeInboundQueue {
  override fail(): void {
    throw new Error("failed queue persistence unavailable");
  }
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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function appEnvelope(input: {
  eventId: string;
  messageId: string;
  sessionId: string;
  text?: string;
}): InboundEnvelope {
  return {
    eventId: input.eventId,
    transport: "app",
    accountId: "local",
    peer: { kind: "dm", id: input.sessionId.replace(/^butler\/app-/, "") },
    sender: { id: "app-user", displayName: "Butler App" },
    message: {
      id: input.messageId,
      text: input.text ?? input.messageId,
      timestamp: "2026-06-11T00:00:00.000Z",
    },
    routingHints: {
      sessionId: input.sessionId,
      turnId: `turn-${input.messageId}`,
    },
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-automation-gateway-"));
  originalButlerData = process.env.BUTLER_DATA;
  process.env.BUTLER_DATA = tempDir;
});

afterEach(() => {
  if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalButlerData;
  rmSync(tempDir, { recursive: true, force: true });
});

test("due automation envelopes route through gateway and session actor", async () => {
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const runtime = new ScriptedRuntime();
  store.upsert({
    sessionId: "butler/main",
    role: "butler",
    projectId: "butler",
    workspacePath: "fixtures/butler-project",
    runtimeAdapterId: runtime.id,
    modelProviderId: fakeProvider.id,
    modelRef: "openai/auto:codex-latest",
    transportBindings: [],
  });
  const automations = new AutomationStore(tempDir);
  automations.create({
    id: "route-test",
    prompt: "Run the scheduled project check.",
    sessionId: "butler/main",
    schedule: {
      type: "once",
      run_at: "2026-04-27T08:00:00.000Z",
    },
  });

  const [run] = automations.claimDue(new Date("2026-04-27T08:00:00.000Z"));
  expect(run).toBeDefined();

  const router = new GatewayRouter({ store });
  const lifecycle = new SessionLifecycleService({
    store,
    runtime,
    provider: fakeProvider,
    systemPromptFactory: () => "You are Butler in an automation test.",
  });
  const server = createGatewayServer({
    router,
    handlers: createLifecycleGatewayHandlers(lifecycle),
  });

  const result = await server.handleInbound(run!.envelope);

  expect(result.status).toBe("handled");
  if (result.status !== "handled") return;
  expect(result.route.reason).toBe("session-hint");
  expect(result.route.sessionId).toBe("butler/main");
  expect(result.handlerResult.metadata?.text).toBe("automation handled");
  expect(runtime.turns[0]?.input).toMatchObject({
    transport: "automation",
    message: {
      text: "Run the scheduled project check.",
    },
  });
});

test("goal completion incomplete runtime errors keep session bindings active", async () => {
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const runtime = new class extends ScriptedRuntime {
    override async runTurn(input: RuntimeTurnInput): Promise<never> {
      this.turns.push(input);
      const error = new Error("아직 완료 증거가 부족합니다.");
      error.name = "GoalCompletionIncompleteError";
      throw error;
    }
  }();
  store.upsert({
    sessionId: "butler/app-general",
    role: "butler",
    workspacePath: tempDir,
    runtimeAdapterId: runtime.id,
    modelProviderId: fakeProvider.id,
    modelRef: "openai/auto:codex-latest",
    transportBindings: [{
      transport: "app",
      accountId: "local",
      peerId: "general",
    }],
  });

  const router = new GatewayRouter({ store });
  const lifecycle = new SessionLifecycleService({
    store,
    runtime,
    provider: fakeProvider,
    systemPromptFactory: () => "You are Butler in an automation test.",
  });
  const server = createGatewayServer({
    router,
    handlers: createLifecycleGatewayHandlers(lifecycle),
  });

  await expect(server.handleInbound({
    eventId: "app:goal-incomplete",
    transport: "app",
    accountId: "local",
    peer: { kind: "dm", id: "general" },
    sender: { id: "app-user", displayName: "Butler App" },
    message: {
      id: "message-goal-incomplete",
      text: "finish the direct work",
      timestamp: "2026-05-18T12:06:00.000Z",
    },
    routingHints: {
      sessionId: "butler/app-general",
      turnId: "turn-goal-incomplete",
    },
  })).rejects.toThrow("아직 완료 증거가 부족합니다");

  expect(store.getBySessionId("butler/app-general")?.lifecycleState)
    .toBe("active");
});

test("queued automation events are consumed by butler-main path and delivered to session transport binding", async () => {
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const runtime = new ScriptedRuntime();
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
      peerId: "operator",
    }, {
      transport: "mock",
      accountId: "default",
      peerId: "observer",
    }],
  });
  const queue = new NativeInboundQueue(tempDir);
  const automations = new AutomationStore(tempDir);
  automations.create({
    id: "queued-route-test",
    prompt: "Run the queued scheduled project check.",
    sessionId: "butler/main",
    schedule: {
      type: "once",
      run_at: "2026-04-27T08:00:00.000Z",
    },
  });
  const [run] = automations.claimDue(new Date("2026-04-27T08:00:00.000Z"));
  queue.enqueue(run!.envelope, { source: "test" });

  const router = new GatewayRouter({ store });
  const lifecycle = new SessionLifecycleService({
    store,
    runtime,
    provider: fakeProvider,
    systemPromptFactory: () => "You are Butler in an automation queue test.",
  });
  const server = createGatewayServer({
    router,
    handlers: createLifecycleGatewayHandlers(lifecycle),
  });
  const mock = new MockTransportAdapter({ id: "mock" });
  const guard = new DeliveryGuard({ adapters: [mock] });

  const summary = await processQueuedInboundEvents({
    queue,
    server,
    store,
    deliveryGuard: guard,
  });

  expect(summary).toMatchObject({
    claimed: 1,
    handled: 1,
    delivered: 2,
    failed: 0,
  });
  expect(runtime.turns[0]?.input).toMatchObject({
    transport: "automation",
    message: {
      text: "Run the queued scheduled project check.",
    },
  });
  expect(
    mock.sentActions.map((action) => ({
      transport: action.transport,
      peer: action.peer,
      text: action.message.text,
    })),
  ).toEqual(
    expect.arrayContaining([
      {
        transport: "mock",
        peer: { kind: "group", id: "operator", threadId: undefined },
        text: "automation handled",
      },
      {
        transport: "mock",
        peer: { kind: "group", id: "observer", threadId: undefined },
        text: "automation handled",
      },
    ]),
  );
});

test("queued inbound skips terminal app turns before dispatch", async () => {
  const queue = new NativeInboundQueue(tempDir);
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  queue.enqueue({
    eventId: "app-terminal-turn",
    transport: "app",
    accountId: "local",
    peer: { kind: "dm", id: "project-chat" },
    sender: { id: "app-user", displayName: "Butler App" },
    message: {
      id: "client-terminal-turn",
      text: "do not run cancelled work",
      timestamp: "2026-06-05T00:00:00.000Z",
    },
    routingHints: {
      sessionId: "butler/app-project-chat",
      turnId: "turn-cancelled",
    },
  }, { source: "test" });

  let handled = false;
  const summary = await processQueuedInboundEvents({
    queue,
    store,
    deliveryGuard: new DeliveryGuard({ adapters: [] }),
    server: {
      async handleInbound() {
        handled = true;
        throw new Error("cancelled app turn should not dispatch");
      },
    },
    shouldHandleItem: () => false,
  });

  expect(summary).toEqual({
    claimed: 1,
    handled: 0,
    delivered: 0,
    failed: 0,
  });
  expect(handled).toBe(false);
  expect(queue.claim(1)).toEqual([]);
  store.close();
});

test("queued inbound dispatcher runs different sessions concurrently", async () => {
  const queue = new NativeInboundQueue(tempDir);
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  queue.enqueue(appEnvelope({
    eventId: "app:session-a",
    messageId: "message-a",
    sessionId: "butler/app-session-a",
  }), { source: "test" });
  queue.enqueue(appEnvelope({
    eventId: "app:session-b",
    messageId: "message-b",
    sessionId: "butler/app-session-b",
  }), { source: "test" });

  const releaseLongTurn = deferred();
  const starts: string[] = [];
  const outcomes: Array<{
    handled: number;
    delivered: number;
    failed: number;
    sessionKey: string;
  }> = [];
  let shortTurnCompleted = false;
  const dispatcher = new QueuedInboundDispatcher();
  const summary = dispatcher.poll({
    queue,
    store,
    deliveryGuard: new DeliveryGuard({ adapters: [] }),
    maxConcurrentSessions: 2,
    limit: 2,
    onOutcome: (outcome) => {
      outcomes.push({
        handled: outcome.handled,
        delivered: outcome.delivered,
        failed: outcome.failed,
        sessionKey: outcome.sessionKey,
      });
    },
    server: {
      async handleInbound(envelope) {
        const sessionId = envelope.routingHints?.sessionId ?? "";
        starts.push(sessionId);
        if (sessionId === "butler/app-session-a") {
          await releaseLongTurn.promise;
        } else {
          shortTurnCompleted = true;
        }
        return {
          status: "handled",
          route: {
            sessionId,
            role: "butler",
            reason: "session-hint",
            workspacePath: tempDir,
          },
          handlerResult: {
            ok: true,
            handledBy: "test",
            metadata: { text: `handled ${sessionId}` },
          },
        };
      },
    },
  });

  expect(summary).toMatchObject({
    claimed: 2,
    handled: 0,
    delivered: 0,
    failed: 0,
  });
  await Promise.resolve();
  expect(summary.claimed).toBe(2);
  expect(starts).toEqual(["butler/app-session-a", "butler/app-session-b"]);
  expect(shortTurnCompleted).toBe(true);

  releaseLongTurn.resolve();
  await dispatcher.waitForIdle();
  expect(summary).toMatchObject({
    claimed: 2,
    handled: 2,
    delivered: 0,
    failed: 0,
  });
  expect(outcomes).toEqual(
    expect.arrayContaining([
      {
        handled: 1,
        delivered: 0,
        failed: 0,
        sessionKey: "butler/app-session-a",
      },
      {
        handled: 1,
        delivered: 0,
        failed: 0,
        sessionKey: "butler/app-session-b",
      },
    ]),
  );
  store.close();
});

test("queued inbound dispatcher preserves same-session FIFO eligibility", async () => {
  const queue = new NativeInboundQueue(tempDir);
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  queue.enqueue(appEnvelope({
    eventId: "app:msg-z0000000-0000-4000-8000-000000000000",
    messageId: "msg-z0000000-0000-4000-8000-000000000000",
    sessionId: "butler/app-same-session",
  }), { source: "test" });
  queue.enqueue(appEnvelope({
    eventId: "app:msg-a0000000-0000-4000-8000-000000000000",
    messageId: "msg-a0000000-0000-4000-8000-000000000000",
    sessionId: "butler/app-same-session",
  }), { source: "test" });

  const releaseFirstTurn = deferred();
  const starts: string[] = [];
  const dispatcher = new QueuedInboundDispatcher();
  const baseOptions = {
    queue,
    store,
    deliveryGuard: new DeliveryGuard({ adapters: [] }),
    maxConcurrentSessions: 2,
    limit: 2,
    server: {
      async handleInbound(envelope: InboundEnvelope) {
        starts.push(envelope.message.id);
        if (envelope.message.id === "msg-z0000000-0000-4000-8000-000000000000") {
          await releaseFirstTurn.promise;
        }
        return {
          status: "handled" as const,
          route: {
            sessionId: envelope.routingHints?.sessionId ?? "",
            role: "butler" as const,
            reason: "session-hint" as const,
            workspacePath: tempDir,
          },
          handlerResult: {
            ok: true,
            handledBy: "test",
            metadata: { text: `handled ${envelope.message.id}` },
          },
        };
      },
    },
  };

  const firstPoll = dispatcher.poll(baseOptions);
  await Promise.resolve();
  expect(firstPoll.claimed).toBe(1);
  expect(starts).toEqual(["msg-z0000000-0000-4000-8000-000000000000"]);
  expect(dispatcher.poll(baseOptions).claimed).toBe(0);

  releaseFirstTurn.resolve();
  await dispatcher.waitForIdle();
  const secondPoll = dispatcher.poll(baseOptions);
  await dispatcher.waitForIdle();

  expect(secondPoll.claimed).toBe(1);
  expect(starts).toEqual([
    "msg-z0000000-0000-4000-8000-000000000000",
    "msg-a0000000-0000-4000-8000-000000000000",
  ]);
  store.close();
});

test("queued inbound dispatcher contains failure persistence rejections", async () => {
  const queue = new PersistenceFailingInboundQueue(tempDir);
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  queue.enqueue(appEnvelope({
    eventId: "app:persistence-failure",
    messageId: "message-persistence-failure",
    sessionId: "butler/app-persistence-failure",
  }), { source: "test" });

  const dispatcher = new QueuedInboundDispatcher();
  const summary = dispatcher.poll({
    queue,
    store,
    deliveryGuard: new DeliveryGuard({ adapters: [] }),
    maxConcurrentSessions: 1,
    limit: 1,
    server: {
      async handleInbound() {
        throw new Error("runtime failed");
      },
    },
  });

  await dispatcher.waitForIdle();

  expect(summary).toMatchObject({
    claimed: 1,
    handled: 0,
    delivered: 0,
    failed: 1,
  });
  store.close();
});

test("queued inbound delivery preserves safe artifact refs for app projection", async () => {
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const runtime = new ScriptedRuntime([{
    id: "artifact-report",
    kind: "document",
    title: "report.md",
    safePathLabel: "reports/report.md",
    localPath: join(tempDir, "reports", "report.md"),
    mimeType: "text/markdown",
  }]);
  store.upsert({
    sessionId: "butler/main",
    role: "butler",
    projectId: "butler",
    workspacePath: "fixtures/butler-project",
    runtimeAdapterId: runtime.id,
    modelProviderId: fakeProvider.id,
    modelRef: "openai/auto:codex-latest",
    transportBindings: [{
      transport: "app",
      accountId: "local",
      peerId: "general",
    }],
  });
  const queue = new NativeInboundQueue(tempDir);
  const automations = new AutomationStore(tempDir);
  automations.create({
    id: "queued-artifact-test",
    prompt: "Run the queued artifact check.",
    sessionId: "butler/main",
    schedule: {
      type: "once",
      run_at: "2026-04-27T08:00:00.000Z",
    },
  });
  const [run] = automations.claimDue(new Date("2026-04-27T08:00:00.000Z"));
  queue.enqueue(run!.envelope, { source: "test" });

  const router = new GatewayRouter({ store });
  const lifecycle = new SessionLifecycleService({
    store,
    runtime,
    provider: fakeProvider,
    systemPromptFactory: () => "You are Butler in an automation queue test.",
  });
  const server = createGatewayServer({
    router,
    handlers: createLifecycleGatewayHandlers(lifecycle),
  });
  const app = new MockTransportAdapter({ id: "app" });
  const guard = new DeliveryGuard({ adapters: [app] });

  const summary = await processQueuedInboundEvents({
    queue,
    server,
    store,
    deliveryGuard: guard,
  });

  expect(summary).toMatchObject({
    claimed: 1,
    handled: 1,
    delivered: 1,
    failed: 0,
  });
  expect(app.sentActions[0]?.message.artifacts?.[0]).toMatchObject({
    id: "artifact-report",
    title: "report.md",
    safePathLabel: "reports/report.md",
    mimeType: "text/markdown",
  });
  expect(JSON.stringify(app.sentActions[0])).not.toContain(tempDir);
});

test("queued inbound runtime failure emits terminal app turn failure action", async () => {
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const queue = new NativeInboundQueue(tempDir);
  const envelope: InboundEnvelope = {
    eventId: "app:message-failure",
    transport: "app",
    accountId: "local",
    peer: { kind: "dm", id: "general" },
    sender: { id: "app-user", displayName: "Butler App" },
    message: {
      id: "message-failure",
      text: "trigger failure",
      timestamp: "2026-05-18T12:03:00.000Z",
    },
    routingHints: {
      sessionId: "butler/app-general",
      turnId: "turn-failure",
    },
  };
  queue.enqueue(envelope, { source: "test" });
  const app = new MockTransportAdapter({ id: "app" });
  const guard = new DeliveryGuard({ adapters: [app] });

  const summary = await processQueuedInboundEvents({
    queue,
    server: {
      async handleInbound() {
        throw new Error("private provider socket details should not surface");
      },
    },
    store,
    deliveryGuard: guard,
  });

  expect(summary).toMatchObject({
    claimed: 1,
    handled: 0,
    delivered: 1,
    failed: 1,
  });
  expect(app.sentActions).toHaveLength(1);
  expect(app.sentActions[0]).toMatchObject({
    transport: "app",
    peer: { kind: "dm", id: "general" },
    message: {
      text: "Butler could not complete this turn.",
      replyToMessageId: "message-failure",
    },
    metadata: {
      kind: "turn_failed",
      turnId: "turn-failure",
      safeErrorCode: "gateway_failed",
    },
  });
  expect(JSON.stringify(app.sentActions[0])).not.toContain("private provider");
});

test("queued inbound provider failure preserves safe API diagnostics for app projection", async () => {
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const queue = new NativeInboundQueue(tempDir);
  queue.enqueue({
    eventId: "app:message-provider-failure",
    transport: "app",
    accountId: "local",
    peer: { kind: "dm", id: "general" },
    sender: { id: "app-user", displayName: "Butler App" },
    message: {
      id: "message-provider-failure",
      text: "trigger provider failure",
      timestamp: "2026-05-18T12:04:00.000Z",
    },
    routingHints: {
      sessionId: "butler/app-general",
      turnId: "turn-provider-failure",
    },
  }, { source: "test" });
  const app = new MockTransportAdapter({ id: "app" });
  const guard = new DeliveryGuard({ adapters: [app] });

  const summary = await processQueuedInboundEvents({
    queue,
    server: {
      async handleInbound() {
        throw new ModelProviderRequestError({
          code: "provider_api_error",
          message: "OpenAI API request failed with HTTP 500.",
          provider: "openai",
          api: "responses",
          statusCode: 500,
          endpoint: "https://api.openai.com/v1/responses",
          model: "gpt-5.5",
          retryable: true,
          cause: "private provider token=secret",
        });
      },
    },
    store,
    deliveryGuard: guard,
  });

  expect(summary).toMatchObject({
    claimed: 1,
    handled: 0,
    delivered: 1,
    failed: 1,
  });
  expect(app.sentActions[0]).toMatchObject({
    message: {
      text: "OpenAI API request failed with HTTP 500.",
    },
    metadata: {
      kind: "turn_failed",
      turnId: "turn-provider-failure",
      safeErrorCode: "provider_api_error",
      provider: "openai",
      api: "responses",
      statusCode: 500,
      endpoint: "https://api.openai.com/v1/responses",
      model: "gpt-5.5",
      retryable: true,
    },
  });
  expect(JSON.stringify(app.sentActions[0])).not.toContain("token=secret");
});

test("queued inbound goal completion incomplete delivers safe limited result", async () => {
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const queue = new NativeInboundQueue(tempDir);
  queue.enqueue({
    eventId: "app:message-goal-incomplete",
    transport: "app",
    accountId: "local",
    peer: { kind: "dm", id: "general" },
    sender: { id: "app-user", displayName: "Butler App" },
    message: {
      id: "message-goal-incomplete",
      text: "continue the long direct task",
      timestamp: "2026-05-18T12:05:00.000Z",
    },
    routingHints: {
      sessionId: "butler/app-general",
      turnId: "turn-goal-incomplete",
    },
  }, { source: "test" });
  const app = new MockTransportAdapter({ id: "app" });
  const guard = new DeliveryGuard({ adapters: [app] });

  const summary = await processQueuedInboundEvents({
    queue,
    server: {
      async handleInbound() {
        const error = new Error(
          "확인된 완료 증거가 아직 부족합니다. token=secret",
        );
        error.name = "GoalCompletionIncompleteError";
        throw error;
      },
    },
    store,
    deliveryGuard: guard,
  });

  expect(summary).toMatchObject({
    claimed: 1,
    handled: 1,
    delivered: 1,
    failed: 0,
  });
  expect(app.sentActions[0]).toMatchObject({
    message: {
      text: "확인된 완료 증거가 아직 부족합니다. [redacted]",
      replyToMessageId: "message-goal-incomplete",
    },
    metadata: {
      kind: "final_result",
      turnId: "turn-goal-incomplete",
      deliveryState: "delivered_with_limitations",
    },
  });
  expect(JSON.stringify(app.sentActions[0])).not.toContain("token=secret");
});

test("queued inbound reactivates hinted crashed app sessions before routing", async () => {
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  store.upsert({
    sessionId: "butler/app-general",
    role: "butler",
    lifecycleState: "crashed",
    workspacePath: tempDir,
    runtimeAdapterId: "native-tool-loop",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.5",
    transportBindings: [{
      transport: "app",
      accountId: "local",
      peerId: "general",
    }],
  });
  const queue = new NativeInboundQueue(tempDir);
  queue.enqueue({
    eventId: "app:message-after-crash",
    transport: "app",
    accountId: "local",
    peer: { kind: "dm", id: "general" },
    sender: { id: "app-user", displayName: "Butler App" },
    message: {
      id: "message-after-crash",
      text: "recover the next app turn",
      timestamp: "2026-05-19T02:07:07.000Z",
    },
    routingHints: {
      sessionId: "butler/app-general",
      turnId: "turn-after-crash",
    },
  }, { source: "test" });
  const app = new MockTransportAdapter({ id: "app" });
  const guard = new DeliveryGuard({ adapters: [app] });

  const summary = await processQueuedInboundEvents({
    queue,
    server: {
      async handleInbound() {
        const binding = store.getBySessionId("butler/app-general");
        if (binding?.lifecycleState !== "active") {
          return {
            status: "unroutable",
            reason: "missing-session",
            details: {
              transport: "app",
              accountId: "local",
              peerId: "general",
              sessionId: "butler/app-general",
            },
          };
        }
        return {
          status: "handled",
          route: {
            sessionId: "butler/app-general",
            role: "butler",
            reason: "session-hint",
            workspacePath: tempDir,
          },
          handlerResult: {
            ok: true,
            handledBy: "test",
            metadata: { text: "recovered after crash" },
          },
        };
      },
    },
    store,
    deliveryGuard: guard,
  });

  expect(summary).toMatchObject({
    claimed: 1,
    handled: 1,
    delivered: 1,
    failed: 0,
  });
  expect(store.getBySessionId("butler/app-general")?.lifecycleState).toBe("active");
  expect(app.sentActions[0]).toMatchObject({
    message: {
      text: "recovered after crash",
    },
    metadata: {
      kind: "final_result",
      turnId: "turn-after-crash",
    },
  });
});

test("queued inbound unroutable app turn emits terminal failure instead of completing pending", async () => {
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const queue = new NativeInboundQueue(tempDir);
  queue.enqueue({
    eventId: "app:message-unroutable",
    transport: "app",
    accountId: "local",
    peer: { kind: "dm", id: "general" },
    sender: { id: "app-user", displayName: "Butler App" },
    message: {
      id: "message-unroutable",
      text: "this should not stay pending",
      timestamp: "2026-05-19T02:08:00.000Z",
    },
    routingHints: {
      sessionId: "butler/app-general",
      turnId: "turn-unroutable",
    },
  }, { source: "test" });
  const app = new MockTransportAdapter({ id: "app" });
  const guard = new DeliveryGuard({ adapters: [app] });

  const summary = await processQueuedInboundEvents({
    queue,
    server: {
      async handleInbound() {
        return {
          status: "unroutable",
          reason: "missing-session",
          details: {
            transport: "app",
            accountId: "local",
            peerId: "general",
            sessionId: "butler/app-general",
          },
        };
      },
    },
    store,
    deliveryGuard: guard,
  });

  expect(summary).toMatchObject({
    claimed: 1,
    handled: 0,
    delivered: 1,
    failed: 1,
  });
  expect(app.sentActions[0]).toMatchObject({
    message: {
      text: "Butler could not route this turn to an active session.",
      replyToMessageId: "message-unroutable",
    },
    metadata: {
      kind: "turn_failed",
      turnId: "turn-unroutable",
      safeErrorCode: "gateway_unroutable",
      dispatchStatus: "unroutable",
    },
  });
});
