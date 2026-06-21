import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
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
import { readTranscript } from "../../packages/butler-agent/src/test-support/harness/transcripts.ts";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { SessionLifecycleService } from "../../packages/butler-agent/src/interfaces/gateway/session-lifecycle.ts";
import type { PromptAssembler } from "../../packages/butler-agent/src/agent/prompt/prompt-assembler.ts";
import { DeliveryGuard } from "../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts";
import { MockTransportAdapter } from "../../packages/butler-agent/src/interfaces/transport/mock/adapter.ts";
import { APP_TRANSPORT } from "../../packages/butler-agent/src/gateways/core/app-transport.ts";
import { FIRST_VISIBLE_PROGRESS_EVENT_KIND } from "../../packages/butler-agent/src/agent/events/turn-events.ts";
import { readFirstVisibleLatencySummary } from "../../packages/butler-agent/src/operations/metrics/first-visible-latency.ts";

let tempDir = "";
let originalButlerData: string | undefined;

class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}

class BlockingRuntime implements AgentRuntimeAdapter {
  readonly id = "blocking-runtime";
  readonly turns: RuntimeTurnInput[] = [];
  readonly firstTurnStarted = new Deferred<void>();
  readonly firstTurnRelease = new Deferred<void>();
  readonly secondTurnStarted = new Deferred<void>();

  constructor(private readonly replyText?: (turnNumber: number) => string) {}

  readonly capabilities = {
    supportsSessionResume: false,
    supportsCompaction: false,
    supportsToolStreaming: false,
    supportsParallelToolCalls: false,
  } as const;

  async createSession(input: RuntimeSessionInit): Promise<RuntimeSessionHandle> {
    return {
      sessionId: input.sessionId,
      role: input.role,
      runtimeAdapterId: this.id,
      runtimeSessionRef: `blocking:${input.sessionId}`,
    };
  }

  async runTurn(input: RuntimeTurnInput) {
    this.turns.push(input);
    if (this.turns.length === 1) {
      this.firstTurnStarted.resolve();
      await this.firstTurnRelease.promise;
    }
    if (this.turns.length === 2) {
      this.secondTurnStarted.resolve();
    }
    await input.emitTurnEvent?.({
      kind: "turn.completed",
      payload: { safeLabel: "Completed" },
    });
    return {
      text: this.replyText?.(this.turns.length) ?? `reply-${this.turns.length}`,
      runtimeSessionRef: input.handle.runtimeSessionRef,
    };
  }

  async closeSession() {}
}

class FailingRuntime implements AgentRuntimeAdapter {
  readonly id = "failing-runtime";
  readonly capabilities = {
    supportsSessionResume: false,
    supportsCompaction: false,
    supportsToolStreaming: false,
    supportsParallelToolCalls: false,
  } as const;

  async createSession(input: RuntimeSessionInit): Promise<RuntimeSessionHandle> {
    return {
      sessionId: input.sessionId,
      role: input.role,
      runtimeAdapterId: this.id,
    };
  }

  async runTurn(): Promise<never> {
    throw new Error("provider unavailable");
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

function inbound(id: string, text: string): InboundEnvelope {
  return {
    eventId: `mock:${id}`,
    transport: "mock",
    accountId: "default",
    peer: { kind: "dm", id: "peer-1" },
    sender: { id: "user-1" },
    message: {
      id,
      text,
      timestamp: new Date().toISOString(),
    },
  };
}

function appInbound(id: string, text: string): InboundEnvelope {
  return {
    ...inbound(id, text),
    eventId: `app:${id}`,
    transport: APP_TRANSPORT,
    routingHints: {
      sessionId: "butler/main",
      turnId: `turn-${id}`,
    },
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-session-actor-serialization-"));
  originalButlerData = process.env.BUTLER_DATA;
  process.env.BUTLER_DATA = tempDir;
});

afterEach(() => {
  if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalButlerData;
  rmSync(tempDir, { recursive: true, force: true });
});

test("session actor serializes concurrent inbound turns in FIFO order", async () => {
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const runtime = new BlockingRuntime();
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

  const lifecycle = new SessionLifecycleService({
    store,
    runtime,
    provider: fakeProvider,
    systemPromptFactory: () => "You are Butler.",
  });
  const actor = await lifecycle.getOrCreate("butler/main", "butler");

  const first = actor.handleInbound(inbound("a", "user turn A"));
  await runtime.firstTurnStarted.promise;

  const second = actor.handleInbound(inbound("worker-complete", "worker completion event"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(runtime.turns).toHaveLength(1);
  expect(runtime.turns[0]!.input).toMatchObject({
    message: { text: "user turn A" },
  });

  runtime.firstTurnRelease.resolve();
  await runtime.secondTurnStarted.promise;

  await expect(first).resolves.toMatchObject({ text: "reply-1" });
  await expect(second).resolves.toMatchObject({ text: "reply-2" });
  expect(runtime.turns).toHaveLength(2);
  expect(runtime.turns[1]!.input).toMatchObject({
    message: { text: "worker completion event" },
  });

  store.close();
});

test("session actor records prompt-loaded skill names on final results", async () => {
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const runtime = new BlockingRuntime();
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
  const promptAssembler = {
    buildSystemPrompt: () => ({ systemPrompt: "You are Butler.", sections: [] }),
    buildTurnContext: () => [
      "Live Configuration Hash: skill-hash",
      "## Skill Catalog",
      "",
      "- status: Status skill.",
      "  applicability: Use when status is relevant.",
      "- project-ledger: Project Ledger skill.",
      "  applicability: Use when Project Ledger is relevant.",
      "",
      "---",
      "",
      "## Current User Input",
      "",
      "Message Text: status",
    ].join("\n"),
  } as unknown as PromptAssembler;

  const lifecycle = new SessionLifecycleService({
    store,
    runtime,
    provider: fakeProvider,
    promptAssembler,
  });
  const actor = await lifecycle.getOrCreate("butler/main", "butler");
  const turn = actor.handleInbound(inbound("skill-context", "status"));
  await runtime.firstTurnStarted.promise;
  runtime.firstTurnRelease.resolve();

  await expect(turn).resolves.toMatchObject({
    loadedSkillNames: ["status", "project-ledger"],
  });
  const transcript = readTranscript("butler/main");
  const loadedEvent = transcript.find((event) =>
    event.kind === "system" &&
    event.payload.category === "context.skills.loaded",
  );
  expect(loadedEvent?.payload.details).toMatchObject({
    skillNames: ["status", "project-ledger"],
  });
  const final = transcript.find((event) => {
    const metadata = event.payload.metadata as Record<string, unknown> | undefined;
    return event.kind === "outbound" && metadata?.kind === "final_result";
  });
  expect(final?.payload.metadata).toMatchObject({
    loadedSkillNames: ["status", "project-ledger"],
  });

  store.close();
});

test("session actor emits typing presence while runtime turn is running", async () => {
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const runtime = new BlockingRuntime();
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
  const lifecycle = new SessionLifecycleService({
    store,
    runtime,
    provider: fakeProvider,
    systemPromptFactory: () => "You are Butler.",
    deliverIntermediate: async ({ binding, action, metadata }) => {
      await guard.deliver(binding.sessionId, action, metadata);
    },
  });
  const actor = await lifecycle.getOrCreate("butler/main", "butler");

  const turn = actor.handleInbound(inbound("typing", "long turn"));
  await runtime.firstTurnStarted.promise;

  expect(mock.sentActions).toHaveLength(1);
  expect(mock.sentActions[0]).toMatchObject({
    transport: "mock",
    accountId: "default",
    peer: { kind: "dm", id: "peer-1" },
    presence: { kind: "typing" },
  });
  expect(mock.sentActions[0]!.message.text).toBeUndefined();

  runtime.firstTurnRelease.resolve();
  await expect(turn).resolves.toMatchObject({ text: "reply-1" });
  store.close();
});

test("session actor attaches turn identity to intermediate activity actions", async () => {
  class IntermediateRuntime implements AgentRuntimeAdapter {
    readonly id = "intermediate-runtime";
    readonly capabilities = {
      supportsSessionResume: false,
      supportsCompaction: false,
      supportsToolStreaming: false,
      supportsParallelToolCalls: false,
    } as const;

    async createSession(input: RuntimeSessionInit): Promise<RuntimeSessionHandle> {
      return {
        sessionId: input.sessionId,
        role: input.role,
        runtimeAdapterId: this.id,
        runtimeSessionRef: `intermediate:${input.sessionId}`,
      };
    }

    async runTurn(input: RuntimeTurnInput) {
      if (!("eventId" in input.input)) {
        return {
          text: "done",
          runtimeSessionRef: input.handle.runtimeSessionRef,
        };
      }
      await input.emitIntermediateDelivery?.(
        {
          actionId: `runtime-intermediate:${input.input.eventId}:tool-progress`,
          transport: input.input.transport,
          accountId: input.input.accountId,
          peer: input.input.peer,
          message: {
            text: "",
            replyToMessageId: input.input.message.id,
          },
          metadata: {
            kind: "tool_progress",
            safeLabel: "Reading files",
          },
        },
        { kind: "tool_progress" },
      );
      return {
        text: "done",
        runtimeSessionRef: input.handle.runtimeSessionRef,
      };
    }
  }

  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const runtime = new IntermediateRuntime();
  const delivered: Array<{ metadata?: Record<string, unknown> }> = [];
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
  const lifecycle = new SessionLifecycleService({
    store,
    runtime,
    provider: fakeProvider,
    systemPromptFactory: () => "You are Butler.",
    deliverIntermediate: async ({ action }) => {
      delivered.push(action);
    },
  });
  const actor = await lifecycle.getOrCreate("butler/main", "butler");

  await expect(actor.handleInbound({
    ...inbound("progress", "show progress"),
    routingHints: { turnId: "turn-progress" },
  })).resolves.toMatchObject({ text: "done" });

  const progressAction = delivered.find(
    (action) => action.metadata?.kind === "tool_progress",
  );
  expect(progressAction?.metadata).toMatchObject({
    kind: "tool_progress",
    sessionId: "butler/main",
    turnId: "turn-progress",
  });
  store.close();
});

test("session actor refreshes runtime sessions when live configuration changes", async () => {
  class LiveConfigRuntime implements AgentRuntimeAdapter {
    readonly id = "live-config-runtime";
    readonly turns: RuntimeTurnInput[] = [];
    created = 0;
    closed = 0;
    readonly capabilities = {
      supportsSessionResume: true,
      supportsCompaction: false,
      supportsToolStreaming: false,
      supportsParallelToolCalls: false,
    } as const;

    async createSession(input: RuntimeSessionInit): Promise<RuntimeSessionHandle> {
      this.created += 1;
      return {
        sessionId: input.sessionId,
        role: input.role,
        runtimeAdapterId: this.id,
        runtimeSessionRef: `live-config:${this.created}`,
      };
    }

    async runTurn(input: RuntimeTurnInput) {
      this.turns.push(input);
      return {
        text: `reply-${this.turns.length}`,
        runtimeSessionRef: input.handle.runtimeSessionRef,
      };
    }

    async closeSession() {
      this.closed += 1;
    }
  }

  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const runtime = new LiveConfigRuntime();
  let hash = "hash-a";
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
  const lifecycle = new SessionLifecycleService({
    store,
    runtime,
    provider: fakeProvider,
    systemPromptFactory: () => "Static runtime prompt.",
    promptAssembler: {
      buildTurnContext: () => `Live Configuration Hash: ${hash}\n\n## Turn Context\nMessage Text: hello`,
    } as unknown as PromptAssembler,
  });
  const actor = await lifecycle.getOrCreate("butler/main", "butler");

  await expect(actor.handleInbound(inbound("hash-a", "first"))).resolves.toMatchObject({
    runtimeSessionRef: "live-config:1",
  });
  hash = "hash-b";
  await expect(actor.handleInbound(inbound("hash-b", "second"))).resolves.toMatchObject({
    runtimeSessionRef: "live-config:2",
  });

  expect(runtime.created).toBe(2);
  expect(runtime.closed).toBe(1);
  expect(runtime.turns.map((turn) => turn.handle.runtimeSessionRef)).toEqual([
    "live-config:1",
    "live-config:2",
  ]);
  expect(store.getBySessionId("butler/main")?.runtimeSessionRef).toBe("live-config:2");
  store.close();
});

test("session actor persists runtime final text and forwards turn events", async () => {
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const runtime = new BlockingRuntime();
  runtime.firstTurnRelease.resolve();
  const turnEvents: string[] = [];
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

  const lifecycle = new SessionLifecycleService({
    store,
    runtime,
    provider: fakeProvider,
    systemPromptFactory: () => "You are Butler.",
    deliverTurnEvent: async ({ event }) => {
      turnEvents.push(event.kind);
    },
  });
  const actor = await lifecycle.getOrCreate("butler/main", "butler");

  await expect(actor.handleInbound({
    ...inbound("final", "hello"),
    routingHints: { turnId: "turn-final" },
  })).resolves.toMatchObject({ text: "reply-1" });

  const transcript = readTranscript("butler/main");
  expect(transcript).toContainEqual(expect.objectContaining({
    kind: "outbound",
    payload: expect.objectContaining({
      actionId: "runtime-final:turn-final",
      message: expect.objectContaining({
        text: "reply-1",
      }),
    }),
  }));
  expect(turnEvents).toContain("turn.completed");
  store.close();
});

test("app session actor emits first visible progress before context preparation", async () => {
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const runtime = new BlockingRuntime();
  runtime.firstTurnRelease.resolve();
  const order: string[] = [];
  const turnEvents: string[] = [];
  store.upsert({
    sessionId: "butler/main",
    role: "butler",
    projectId: "butler",
    workspacePath: "fixtures/butler-project",
    runtimeAdapterId: runtime.id,
    modelProviderId: fakeProvider.id,
    modelRef: "openai/auto:codex-latest",
    transportBindings: [{
      transport: APP_TRANSPORT,
      accountId: "local",
      peerId: "butler/main",
    }],
  });

  const lifecycle = new SessionLifecycleService({
    store,
    runtime,
    provider: fakeProvider,
    promptAssembler: {
      buildSystemPrompt: () => ({ systemPrompt: "You are Butler." }),
      buildTurnContext: () => {
        order.push("buildTurnContext");
        return "context";
      },
    } as unknown as PromptAssembler,
    deliverTurnEvent: async ({ event }) => {
      order.push(`turnEvent:${event.kind}`);
      turnEvents.push(event.kind);
    },
  });
  const actor = await lifecycle.getOrCreate("butler/main", "butler");

  await expect(actor.handleInbound(appInbound("first-progress", "hello"))).resolves.toMatchObject({
    text: "reply-1",
  });

  expect(turnEvents[0]).toBe(FIRST_VISIBLE_PROGRESS_EVENT_KIND);
  expect(order.indexOf(`turnEvent:${FIRST_VISIBLE_PROGRESS_EVENT_KIND}`)).toBeLessThan(
    order.indexOf("buildTurnContext"),
  );
  const summary = readFirstVisibleLatencySummary({ butlerData: tempDir });
  expect(summary).toMatchObject({
    events: 1,
    bySignal: {
      first_progress: 1,
    },
    privacy: {
      rawTextStored: false,
    },
  });
  expect(summary.latest?.dimensions).toMatchObject({
    transport: APP_TRANSPORT,
    role: "butler",
    source: "gateway-actor",
  });
  store.close();
});

test("non-app session actor does not emit app first visible progress", async () => {
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const runtime = new BlockingRuntime();
  runtime.firstTurnRelease.resolve();
  const turnEvents: string[] = [];
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

  const lifecycle = new SessionLifecycleService({
    store,
    runtime,
    provider: fakeProvider,
    systemPromptFactory: () => "You are Butler.",
    deliverTurnEvent: async ({ event }) => {
      turnEvents.push(event.kind);
    },
  });
  const actor = await lifecycle.getOrCreate("butler/main", "butler");

  await expect(actor.handleInbound(inbound("mock-progress", "hello"))).resolves.toMatchObject({
    text: "reply-1",
  });

  expect(turnEvents).not.toContain(FIRST_VISIBLE_PROGRESS_EVENT_KIND);
  expect(readFirstVisibleLatencySummary({ butlerData: tempDir }).events).toBe(0);
  store.close();
});

test("app session actor keeps first visible progress when runtime fails", async () => {
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const runtime = new FailingRuntime();
  const turnEvents: string[] = [];
  store.upsert({
    sessionId: "butler/main",
    role: "butler",
    projectId: "butler",
    workspacePath: "fixtures/butler-project",
    runtimeAdapterId: runtime.id,
    modelProviderId: fakeProvider.id,
    modelRef: "openai/auto:codex-latest",
    transportBindings: [{
      transport: APP_TRANSPORT,
      accountId: "local",
      peerId: "butler/main",
    }],
  });

  const lifecycle = new SessionLifecycleService({
    store,
    runtime,
    provider: fakeProvider,
    systemPromptFactory: () => "You are Butler.",
    deliverTurnEvent: async ({ event }) => {
      turnEvents.push(event.kind);
    },
  });
  const actor = await lifecycle.getOrCreate("butler/main", "butler");

  await expect(actor.handleInbound(appInbound("runtime-fails", "hello"))).rejects.toThrow(
    "provider unavailable",
  );

  expect(turnEvents[0]).toBe(FIRST_VISIBLE_PROGRESS_EVENT_KIND);
  expect(store.getBySessionId("butler/main")?.lifecycleState).toBe("crashed");
  store.close();
});

test("app session actor treats first visible progress delivery as best effort", async () => {
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const runtime = new BlockingRuntime();
  runtime.firstTurnRelease.resolve();
  const turnEvents: string[] = [];
  store.upsert({
    sessionId: "butler/main",
    role: "butler",
    projectId: "butler",
    workspacePath: "fixtures/butler-project",
    runtimeAdapterId: runtime.id,
    modelProviderId: fakeProvider.id,
    modelRef: "openai/auto:codex-latest",
    transportBindings: [{
      transport: APP_TRANSPORT,
      accountId: "local",
      peerId: "butler/main",
    }],
  });

  const lifecycle = new SessionLifecycleService({
    store,
    runtime,
    provider: fakeProvider,
    systemPromptFactory: () => "You are Butler.",
    deliverTurnEvent: async ({ event }) => {
      turnEvents.push(event.kind);
      if (event.kind === FIRST_VISIBLE_PROGRESS_EVENT_KIND) {
        throw new Error("event store unavailable");
      }
    },
  });
  const actor = await lifecycle.getOrCreate("butler/main", "butler");

  await expect(actor.handleInbound(appInbound("first-progress-delivery-fails", "hello"))).resolves.toMatchObject({
    text: "reply-1",
  });

  expect(turnEvents[0]).toBe(FIRST_VISIBLE_PROGRESS_EVENT_KIND);
  expect(turnEvents).toContain("turn.completed");
  expect(readFirstVisibleLatencySummary({ butlerData: tempDir }).events).toBe(0);
  store.close();
});

test("session actor persists empty runtime final markers for durable turn continuity", async () => {
  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const runtime = new BlockingRuntime(() => "   ");
  runtime.firstTurnRelease.resolve();
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

  const lifecycle = new SessionLifecycleService({
    store,
    runtime,
    provider: fakeProvider,
    systemPromptFactory: () => "You are Butler.",
  });
  const actor = await lifecycle.getOrCreate("butler/main", "butler");

  await expect(actor.handleInbound({
    ...inbound("empty-final", "tool-only turn"),
    routingHints: { turnId: "turn-empty-final" },
  })).resolves.toMatchObject({ text: "   " });

  const transcript = readTranscript("butler/main");
  expect(transcript).toContainEqual(expect.objectContaining({
    kind: "outbound",
    payload: expect.objectContaining({
      actionId: "runtime-final:turn-empty-final",
      message: expect.objectContaining({
        text: "[turn completed without public final text]",
      }),
      metadata: expect.objectContaining({
        emptyFinal: true,
      }),
    }),
    metadata: expect.objectContaining({
      turnId: "turn-empty-final",
    }),
  }));
  store.close();
});
