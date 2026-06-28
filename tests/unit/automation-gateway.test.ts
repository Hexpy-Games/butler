import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
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
import { PromptAssembler } from "../../packages/butler-agent/src/agent/prompt/prompt-assembler.ts";
import { NativeToolLoopRuntime } from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import { normalizeTurnPrompt } from "../../packages/butler-agent/src/agent/turn/native/context/turn-prompt.ts";
import {
  createTurnContextAtomId,
  readTurnContextAtom,
} from "../../packages/butler-agent/src/agent/turn/turn-continuation-context.ts";
import { WorkStreamStore } from "../../packages/butler-agent/src/agent/work/work-stream.ts";
import { TodoListStore } from "../../packages/butler-agent/src/agent/work/todo-list.ts";
import { readTranscript } from "../../packages/butler-agent/src/test-support/harness/transcripts.ts";

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
  override fail(): boolean {
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

test("queued inbound dispatcher fails timed out app turns and holds the session slot until quiescence", async () => {
  const queue = new NativeInboundQueue(tempDir);
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  queue.enqueue(appEnvelope({
    eventId: "app:timeout",
    messageId: "message-timeout",
    sessionId: "butler/app-timeout",
  }), { source: "test" });
  queue.enqueue(appEnvelope({
    eventId: "app:after-timeout",
    messageId: "message-after-timeout",
    sessionId: "butler/app-timeout",
  }), { source: "test" });
  const app = new MockTransportAdapter({ id: "app" });
  const dispatcher = new QueuedInboundDispatcher();
  const guard = new DeliveryGuard({ adapters: [app] });
  let sawAbort = false;
  const releaseTimedOutHandler = deferred<void>();

  const first = dispatcher.poll({
    queue,
    store,
    deliveryGuard: guard,
    maxConcurrentSessions: 1,
    limit: 1,
    dispatchTimeoutMs: 5,
    server: {
      async handleInbound(envelope) {
        envelope.signal?.addEventListener("abort", () => {
          sawAbort = true;
        });
        await releaseTimedOutHandler.promise;
        return {
          status: "handled",
          route: {
            sessionId: envelope.routingHints?.sessionId ?? "",
            role: "butler",
            reason: "session-hint",
            workspacePath: tempDir,
          },
          handlerResult: {
            ok: true,
            metadata: { durableFinalRecorded: true },
          },
        };
      },
    },
  });
  expect(first.claimed).toBe(1);
  await dispatcher.waitForIdle();

  expect(sawAbort).toBe(true);
  expect(app.sentActions[0]).toMatchObject({
    transport: "app",
    message: {
      text: "Butler did not finish this queued request before the dispatch lease expired. Retry the turn.",
      replyToMessageId: "message-timeout",
    },
    metadata: {
      kind: "turn_failed",
      turnId: "turn-message-timeout",
      safeErrorCode: "inbound_dispatch_timeout",
    },
  });
  const failedDir = join(tempDir, "runtime", "inbound-events", "failed");
  const failedFiles = existsSync(failedDir) ? readdirSync(failedDir) : [];
  expect(failedFiles).toHaveLength(1);
  const failedRecord = JSON.parse(readFileSync(join(failedDir, failedFiles[0]!), "utf8"));
  expect(failedRecord.metadata.terminalClaimId).toBeString();

  const blockedByUnsettledTimeout = dispatcher.poll({
    queue,
    store,
    deliveryGuard: guard,
    maxConcurrentSessions: 1,
    limit: 1,
    dispatchTimeoutMs: 5,
    server: {
      async handleInbound(envelope) {
        return {
          status: "handled",
          route: {
            sessionId: envelope.routingHints?.sessionId ?? "",
            role: "butler",
            reason: "session-hint",
            workspacePath: tempDir,
          },
          handlerResult: {
            ok: true,
            metadata: { durableFinalRecorded: true },
          },
        };
      },
    },
  });
  expect(blockedByUnsettledTimeout.claimed).toBe(0);

  releaseTimedOutHandler.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const second = dispatcher.poll({
    queue,
    store,
    deliveryGuard: guard,
    maxConcurrentSessions: 1,
    limit: 1,
    dispatchTimeoutMs: 5,
    server: {
      async handleInbound(envelope) {
        return {
          status: "handled",
          route: {
            sessionId: envelope.routingHints?.sessionId ?? "",
            role: "butler",
            reason: "session-hint",
            workspacePath: tempDir,
          },
          handlerResult: {
            ok: true,
            metadata: { durableFinalRecorded: true },
          },
        };
      },
    },
  });
  expect(second.claimed).toBe(1);
  await dispatcher.waitForIdle();
  const processedDir = join(tempDir, "runtime", "inbound-events", "processed");
  expect(existsSync(processedDir) ? readdirSync(processedDir).length : 0).toBe(1);
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

test("queued inbound dispatcher does not time out active app turns by default", async () => {
  const queue = new NativeInboundQueue(tempDir);
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  queue.enqueue(appEnvelope({
    eventId: "app:long-running-default",
    messageId: "message-long-running-default",
    sessionId: "butler/app-long-running-default",
  }), { source: "test" });
  const app = new MockTransportAdapter({ id: "app" });
  const dispatcher = new QueuedInboundDispatcher();
  const guard = new DeliveryGuard({ adapters: [app] });
  const releaseHandler = deferred<void>();
  store.upsert({
    sessionId: "butler/app-long-running-default",
    role: "butler",
    projectId: "butler",
    workspacePath: tempDir,
    runtimeAdapterId: "test-runtime",
    modelProviderId: fakeProvider.id,
    modelRef: "openai/auto:codex-latest",
    transportBindings: [{
      transport: "app",
      accountId: "local",
      peerId: "long-running-default",
    }],
    lifecycleState: "active",
  });

  const first = dispatcher.poll({
    queue,
    store,
    deliveryGuard: guard,
    maxConcurrentSessions: 1,
    limit: 1,
    processingLeaseMs: 5,
    server: {
      async handleInbound(envelope) {
        await releaseHandler.promise;
        return {
          status: "handled",
          route: {
            sessionId: envelope.routingHints?.sessionId ?? "",
            role: "butler",
            reason: "session-hint",
            workspacePath: tempDir,
          },
          handlerResult: {
            ok: true,
            metadata: { text: "done after long work" },
          },
        };
      },
    },
  });
  expect(first.claimed).toBe(1);

  await new Promise((resolve) => setTimeout(resolve, 15));
  const whileActive = dispatcher.poll({
    queue,
    store,
    deliveryGuard: guard,
    maxConcurrentSessions: 1,
    limit: 1,
    processingLeaseMs: 5,
    server: {
      async handleInbound() {
        throw new Error("active turn should not be reprocessed");
      },
    },
  });
  expect(whileActive.claimed).toBe(0);
  expect(app.sentActions).toEqual([]);
  expect(existsSync(join(tempDir, "runtime", "inbound-events", "pending")) ?
    readdirSync(join(tempDir, "runtime", "inbound-events", "pending")) :
    []).toEqual([]);
  expect(existsSync(join(tempDir, "runtime", "inbound-events", "failed")) ?
    readdirSync(join(tempDir, "runtime", "inbound-events", "failed")) :
    []).toEqual([]);

  releaseHandler.resolve();
  await dispatcher.waitForIdle();

  expect(app.sentActions).toHaveLength(1);
  expect(app.sentActions[0]).toMatchObject({
    transport: "app",
    message: {
      text: "done after long work",
      replyToMessageId: "message-long-running-default",
    },
    metadata: {
      kind: "final_result",
      turnId: "turn-message-long-running-default",
    },
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

test("queued inbound schedules same-logical-turn continuation for raw model-call budget exhaustion", async () => {
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const queue = new NativeInboundQueue(tempDir);
  queue.enqueue({
    eventId: "app:message-budget-failure",
    transport: "app",
    accountId: "local",
    peer: { kind: "dm", id: "general" },
    sender: { id: "app-user", displayName: "Butler App" },
    message: {
      id: "message-budget-failure",
      text: "continue until budget failure",
      timestamp: "2026-05-18T12:04:30.000Z",
    },
    routingHints: {
      sessionId: "butler/app-general",
      turnId: "turn-budget-failure",
    },
  }, { source: "test" });
  const app = new MockTransportAdapter({ id: "app" });
  const guard = new DeliveryGuard({ adapters: [app] });

  const summary = await processQueuedInboundEvents({
    queue,
    server: {
      async handleInbound() {
        const error = new Error(
          "Prompt usage model-call budget exhausted before provider request",
        );
        error.name = "PromptUsageModelCallBudgetExhaustedError";
        Object.assign(error, {
          code: "prompt_usage_model_call_budget_exhausted",
        });
        throw error;
      },
    },
    store,
    deliveryGuard: guard,
  });

  expect(summary).toMatchObject({
    claimed: 1,
    handled: 1,
    delivered: 0,
    failed: 0,
  });
  expect(app.sentActions).toHaveLength(0);
  const pendingRecords = readdirSync(join(tempDir, "runtime", "inbound-events", "pending"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(tempDir, "runtime", "inbound-events", "pending", name), "utf8")));
  expect(pendingRecords).toHaveLength(1);
  expect(pendingRecords[0].metadata).toMatchObject({
    sameLogicalTurnContinuation: true,
    continuationTurnId: "turn-budget-failure",
    contextAtomId: createTurnContextAtomId("butler/app-general", "turn-budget-failure"),
  });
  const persisted = readTurnContextAtom({
    butlerData: tempDir,
    sessionId: "butler/app-general",
    turnId: "turn-budget-failure",
  });
  expect(persisted).toMatchObject({
    sessionId: "butler/app-general",
    turnId: "turn-budget-failure",
    state: "continuing",
    sourceErrorCode: "internal_recovery_required",
  });
  store.close();
});

test("scheduler continuation metadata fails closed when its atom is unavailable", () => {
  expect(() => normalizeTurnPrompt({
    handle: {
      sessionId: "butler/app-general",
      role: "butler",
      runtimeAdapterId: "native-tool-loop",
      runtimeSessionRef: "runtime:missing-continuation",
    },
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: appEnvelope({
      eventId: "app:missing-continuation",
      messageId: "client-missing-continuation",
      sessionId: "butler/app-general",
      text: "this must not reopen as normal inbound",
    }),
    metadata: {
      turnId: "turn-client-missing-continuation",
      schedulerContinuation: {
        contextAtomId: createTurnContextAtomId("butler/app-general", "turn-client-missing-continuation"),
      },
    },
  }, {
    recentConversationTokenBudget: 1_000,
    butlerData: tempDir,
  })).toThrow("Scheduler continuation context atom could not be read");
});

test("queued inbound completion gap consumes same logical turn continuation without second inbound", async () => {
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const prompts: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    messageLanguage: "en",
    butlerData: tempDir,
    executeButlerTool: async () => ({
      ok: true,
      ...(prompts.length > 1 ? {
        evidence_capability_receipts: [{
          receipt_id: "receipt-queued-command",
          schema_version: "evidence-capability.v1",
          producer: { kind: "tool", name: "run_command" },
          capability: "command_executed",
          evidence_kind: "execution_result",
          maturity: "verified",
          confidence: 1,
          verified: true,
          summary: "Command execution was verified.",
          limitations: [],
          references: [{ task_id: "queued-command" }],
          satisfies: ["command_executed"],
          created_at: "2026-06-28T00:00:00.000Z",
        }],
      } : {}),
    }),
    runFunctionToolPromptText: async (input) => {
      prompts.push(input.prompt);
      await input.onAssistantTextBeforeTools?.({
        text: [
          "summary: I am running the requested command.",
          "rationale: completion requires command evidence.",
          "next_step: summarize after evidence exists.",
          "completion_obligations: command_executed",
        ].join("\n"),
        toolCalls: [{ name: "run_command", args: { command: "pwd" } }],
      });
      await input.executeTool({
        name: "run_command",
        args: { command: "pwd" },
        rawArguments: JSON.stringify({ command: "pwd" }),
      });
      return prompts.length === 1
        ? "I have not captured command evidence yet."
        : "Command evidence is verified and this is the final result.";
    },
  });
  store.upsert({
    sessionId: "butler/app-general",
    role: "butler",
    workspacePath: tempDir,
    runtimeAdapterId: runtime.id,
    modelProviderId: fakeProvider.id,
    modelRef: "openai/gpt-5.5",
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
  let inboundDispatches = 0;
  const queue = new NativeInboundQueue(tempDir);
  queue.enqueue({
    eventId: "app:completion-gap-continuation",
    transport: "app",
    accountId: "local",
    peer: { kind: "dm", id: "general" },
    sender: { id: "app-user", displayName: "Butler App" },
    message: {
      id: "message-completion-gap-continuation",
      text: "Run command and summarize.",
      timestamp: "2026-06-28T00:00:00.000Z",
    },
    routingHints: {
      sessionId: "butler/app-general",
      turnId: "turn-completion-gap-continuation",
    },
  }, { source: "test" });
  const app = new MockTransportAdapter({ id: "app" });
  const guard = new DeliveryGuard({ adapters: [app] });

  const summary = await processQueuedInboundEvents({
    queue,
    server: {
      async handleInbound(envelope) {
        inboundDispatches += 1;
        return server.handleInbound(envelope);
      },
    },
    store,
    deliveryGuard: guard,
  });

  expect(summary).toMatchObject({
    claimed: 1,
    handled: 1,
    failed: 0,
  });
  expect(inboundDispatches).toBe(1);
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("Completion review produced a model-visible observation");
  expect(readTurnContextAtom({
    butlerData: tempDir,
    sessionId: "butler/app-general",
    turnId: "turn-completion-gap-continuation",
  })).toBeNull();
  expect(JSON.stringify(app.sentActions)).not.toContain("not captured command evidence");
  store.close();
});

test("queued inbound converts normalized internal recovery failures to limited delivery", async () => {
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const queue = new NativeInboundQueue(tempDir);
  queue.enqueue({
    eventId: "app:message-normalized-internal-recovery",
    transport: "app",
    accountId: "local",
    peer: { kind: "dm", id: "general" },
    sender: { id: "app-user", displayName: "Butler App" },
    message: {
      id: "message-normalized-internal-recovery",
      text: "continue after normalized internal recovery",
      timestamp: "2026-05-18T12:04:45.000Z",
    },
    routingHints: {
      sessionId: "butler/app-general",
      turnId: "turn-normalized-internal-recovery",
    },
  }, { source: "test" });
  const app = new MockTransportAdapter({ id: "app" });
  const guard = new DeliveryGuard({ adapters: [app] });

  const summary = await processQueuedInboundEvents({
    queue,
    server: {
      async handleInbound() {
        throw {
          code: "internal_recovery_required",
          message: "Butler could not verify that the requested goal was completed.",
          retryable: true,
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
  expect(app.sentActions).toHaveLength(1);
  expect(app.sentActions[0]).toMatchObject({
    transport: "app",
    message: {
      text: "",
      replyToMessageId: "message-normalized-internal-recovery",
    },
    metadata: {
      kind: "final_result",
      turnId: "turn-normalized-internal-recovery",
      noVisibleReply: true,
      deliveryState: "needs_evidence",
      limitationCodes: ["internal_recovery_required"],
    },
  });
  expect(JSON.stringify(app.sentActions[0])).not.toContain("turn_failed");
  expect(JSON.stringify(app.sentActions[0])).not.toContain("requested goal was completed");
  store.close();
});

test("queued app prompt-budget yield resumes same logical turn from durable W3 todo context", async () => {
  const butlerHome = join(tempDir, "home");
  mkdirSync(join(butlerHome, "resources", "prompts"), { recursive: true });
  mkdirSync(join(tempDir, "personas"), { recursive: true });
  writeFileSync(join(butlerHome, "resources", "prompts", "runtime-system-contract.md"), "RUNTIME_CONTRACT", "utf8");
  writeFileSync(join(butlerHome, "resources", "prompts", "butler.md"), "BUTLER_ROLE", "utf8");
  writeFileSync(join(tempDir, "personas", "active.md"), "PERSONA_BODY", "utf8");

  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  let promptCallCount = 0;
  let resumePrompt = "";
  const turnEvents: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  const runtime = new NativeToolLoopRuntime({
    butlerHome,
    butlerData: tempDir,
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    runFunctionToolPromptText: async (input) => {
      promptCallCount += 1;
      if (promptCallCount === 1) {
        await input.executeTool({
          name: "update_todo_list",
          args: {
            title: "Sandy style guard validation",
            todos: [{
              id: "w3-style-guard",
              content: "Inspect Sandy style guard validation evidence",
              active_form: "Inspecting Sandy style guard validation evidence",
              status: "in_progress",
              phase: "execution",
            }, {
              id: "w4-report",
              content: "Report Sandy style guard validation result",
              active_form: "Reporting Sandy style guard validation result",
              status: "pending",
              phase: "reporting",
            }],
          },
          rawArguments: JSON.stringify({ title: "Sandy style guard validation" }),
        });
        await input.onAssistantTextBeforeTools?.({
          text: [
            "summary: Inspect Sandy style guard validation evidence.",
            "rationale: The user asked to continue from W3 with durable work state.",
            "next_step: Capture a small validation receipt before continuing.",
          ].join("\n"),
          toolCalls: [{
            name: "run_command",
            args: { command: "printf 'w3 evidence\\n'" },
          }],
        });
        await input.executeTool({
          name: "run_command",
          args: {
            command: "printf 'w3 evidence\\n'",
          },
          rawArguments: JSON.stringify({ command: "printf 'w3 evidence\\n'" }),
        });
        const error = new Error("Prompt usage model-call budget exhausted before provider request");
        error.name = "PromptUsageModelCallBudgetExhaustedError";
        Object.assign(error, { code: "prompt_usage_model_call_budget_exhausted" });
        throw error;
      }
      resumePrompt = input.prompt;
      await input.executeTool({
        name: "update_todo_list",
        args: {
          list_id: "main",
          title: "Sandy style guard validation",
          todos: [{
            id: "w3-style-guard",
            content: "Inspect Sandy style guard validation evidence",
            active_form: "Inspecting Sandy style guard validation evidence",
            status: "completed",
            phase: "execution",
          }, {
            id: "w4-report",
            content: "Report Sandy style guard validation result",
            active_form: "Reporting Sandy style guard validation result",
            status: "completed",
            phase: "reporting",
          }],
        },
        rawArguments: JSON.stringify({ list_id: "main", title: "Sandy style guard validation" }),
      });
      return "W3 style guard validation evidence부터 이어서 처리했습니다.";
    },
  });
  const sessionId = "butler/app-general";
  store.upsert({
    sessionId,
    role: "butler",
    projectId: "sandy",
    workspacePath: tempDir,
    runtimeAdapterId: runtime.id,
    modelProviderId: fakeProvider.id,
    modelRef: "openai/auto:codex-latest",
    transportBindings: [{
      transport: "app",
      accountId: "local",
      peerId: "general",
    }],
    metadata: {
      runtimePolicy: { completionReview: "disabled" },
    },
  });
  const router = new GatewayRouter({ store });
  const lifecycle = new SessionLifecycleService({
    store,
    runtime,
    provider: fakeProvider,
    promptAssembler: new PromptAssembler({ butlerHome, butlerData: tempDir }),
    systemPromptFactory: () => "You are Butler in a queued app continuation test.",
    deliverTurnEvent: async ({ event }) => {
      turnEvents.push({
        kind: event.kind,
        payload: event.payload as Record<string, unknown> | undefined,
      });
    },
  });
  const server = createGatewayServer({
    router,
    handlers: createLifecycleGatewayHandlers(lifecycle),
    butlerData: tempDir,
  });
  const queue = new NativeInboundQueue(tempDir);
  const app = new MockTransportAdapter({ id: "app" });
  const guard = new DeliveryGuard({ adapters: [app] });

  queue.enqueue(appEnvelope({
    eventId: "app:w3-budget-first",
    messageId: "client-w3-budget-first",
    sessionId,
    text: "샌디봇 최신세션 W3부터 계속 진행해줘.",
  }), { source: "test" });

  const first = await processQueuedInboundEvents({
    queue,
    server,
    store,
    deliveryGuard: guard,
  });

  expect(first).toMatchObject({
    claimed: 1,
    handled: 1,
    delivered: 0,
    failed: 0,
  });
  expect(app.sentActions).toHaveLength(0);
  expect(promptCallCount).toBe(1);
  expect(resumePrompt).toBe("");
  expect(turnEvents.filter((event) => event.kind === "turn.acknowledged")).toHaveLength(1);

  const persisted = readTurnContextAtom({
    butlerData: tempDir,
    sessionId,
    turnId: "turn-client-w3-budget-first",
  });
  expect(persisted).toMatchObject({
    state: "continuing",
    unresolvedObservations: [expect.objectContaining({
      kind: "context_compacted",
    })],
    currentTurnWork: [expect.objectContaining({
      kind: "work_stream",
    })],
    currentTurnTodos: expect.arrayContaining([
      expect.objectContaining({ kind: "todo_list" }),
      expect.objectContaining({ kind: "todo_item" }),
    ]),
    latestAssistantDecision: expect.objectContaining({
      id: expect.stringContaining("decision-"),
    }),
  });

  const streamStore = new WorkStreamStore(tempDir);
  const streams = streamStore.list({ sessionId, includeTerminal: true });
  expect(streams).toHaveLength(1);
  expect(streams[0]).toMatchObject({
    state: "executing",
    terminal: false,
  });
  const stream = streamStore.read(streams[0].id);
  const todos = new TodoListStore(tempDir).view(stream!.todo_list_id!, { includeCompleted: true });
  expect(todos.items).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: "w3-style-guard",
      status: "in_progress",
      active_form: "Inspecting Sandy style guard validation evidence",
    }),
    expect.objectContaining({
      id: "w4-report",
      status: "pending",
    }),
  ]));

  const pendingDir = join(tempDir, "runtime", "inbound-events", "pending");
  expect(readdirSync(pendingDir).filter((name) => name.endsWith(".json"))).toHaveLength(1);

  const second = await processQueuedInboundEvents({
    queue,
    server,
    store,
    deliveryGuard: guard,
  });

  expect(second).toMatchObject({
    claimed: 1,
    handled: 1,
    delivered: 0,
    failed: 0,
  });
  expect(promptCallCount).toBe(2);
  expect(turnEvents.filter((event) => event.kind === "turn.acknowledged")).toHaveLength(1);
  expect(readTranscript(sessionId).filter((event) => event.kind === "inbound")).toHaveLength(1);
  expect(resumePrompt).toContain("## Scheduler Continuation Context Atom");
  expect(resumePrompt.indexOf("## Scheduler Continuation Context Atom"))
    .toBeLessThan(resumePrompt.indexOf("## Active Work State"));
  expect(resumePrompt).toContain("Latest Assistant Decision Ref: decision-");
  expect(resumePrompt.indexOf("Latest Assistant Decision Ref:"))
    .toBeLessThan(resumePrompt.indexOf("## Active Work State"));
  expect(resumePrompt).toContain(
    `Context Atom ID: ${createTurnContextAtomId(sessionId, "turn-client-w3-budget-first")}`,
  );
  expect(resumePrompt).toContain("Unresolved Observations:");
  expect(resumePrompt).toContain("context_compacted:context-atom:");
  expect(resumePrompt).toContain("Current Turn Work:");
  expect(resumePrompt).toContain("work_stream:");
  expect(resumePrompt).toContain("Current Turn Todos:");
  expect(resumePrompt).toContain("todo_item:");
  expect(resumePrompt).toContain("## Active Work State");
  expect(resumePrompt).toContain("w3-style-guard:in_progress:execution:Inspecting Sandy style guard validation evidence");
  expect(resumePrompt).not.toContain("model-call budget");

  const completedStreams = streamStore.list({ sessionId, includeTerminal: true });
  expect(completedStreams).toHaveLength(1);
  expect(completedStreams[0]).toMatchObject({
    state: "complete",
    terminal: true,
  });
  const completedTodos = new TodoListStore(tempDir).view(stream!.todo_list_id!, { includeCompleted: true });
  expect(completedTodos.items).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: "w3-style-guard",
      status: "completed",
      active_form: "Inspecting Sandy style guard validation evidence",
    }),
    expect.objectContaining({
      id: "w4-report",
      status: "completed",
    }),
  ]));
  store.close();
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
      text: "",
      replyToMessageId: "message-goal-incomplete",
    },
    metadata: {
      kind: "final_result",
      turnId: "turn-goal-incomplete",
      deliveryState: "needs_evidence",
      limitationCodes: ["internal_recovery_required"],
      limitations: [],
      noVisibleReply: true,
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
