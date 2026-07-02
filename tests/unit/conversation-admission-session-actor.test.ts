import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { SessionLifecycleService } from "../../packages/butler-agent/src/interfaces/gateway/session-lifecycle.ts";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { readTranscript } from "../../packages/butler-agent/src/test-support/harness/transcripts.ts";
import type {
  AgentRuntimeAdapter,
  InboundEnvelope,
  ModelProviderAdapter,
  RuntimeSessionHandle,
  RuntimeSessionInit,
  RuntimeTurnInput,
} from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

let tempDir = "";
let originalButlerData: string | undefined;

const provider: ModelProviderAdapter = {
  id: "fake-provider",
  capabilities: {
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsImages: false,
    supportsAudio: false,
    supportsServerThreads: false,
    supportsReasoningConfig: true,
    supportsPromptCaching: false,
  },
  async invoke() {
    return { text: "unused" };
  },
};

class AdmissionRuntime implements AgentRuntimeAdapter {
  readonly id = "admission-runtime";
  readonly capabilities = {
    supportsSessionResume: false,
    supportsCompaction: false,
    supportsToolStreaming: true,
    supportsParallelToolCalls: false,
  } as const;

  async createSession(input: RuntimeSessionInit): Promise<RuntimeSessionHandle> {
    return {
      sessionId: input.sessionId,
      role: input.role,
      runtimeAdapterId: this.id,
    };
  }

  async runTurn(input: RuntimeTurnInput) {
    await input.emitTurnEvent?.({
      kind: "model.stream.text_delta",
      payload: {
        streamId: "stream-1",
        textDelta: "partial",
        target: "final_candidate",
      },
    });
    await input.emitTurnEvent?.({
      kind: "tool.started",
      payload: {
        toolCallId: "tool-1",
        toolName: "Read File",
        safeLabel: "Reading file",
      },
    });
    await input.emitTurnEvent?.({
      kind: "tool.completed",
      payload: {
        toolCallId: "tool-1",
        toolName: "Read File",
        safeLabel: "Read complete",
      },
    });
    await input.emitTurnEvent?.({
      kind: "turn.completed",
      payload: { safeLabel: "Done" },
    });
    return { text: "final answer" };
  }
}

function inbound(
  id: string,
  text: string,
  input: {
    transport?: string;
    senderId?: string;
    raw?: Record<string, unknown>;
  } = {},
): InboundEnvelope {
  return {
    eventId: `mock:${id}`,
    transport: input.transport ?? "mock",
    accountId: "default",
    peer: { kind: "dm", id: "peer-1" },
    sender: { id: input.senderId ?? "user-1" },
    message: {
      id,
      text,
      timestamp: "2026-07-02T00:00:00.000Z",
    },
    routingHints: { turnId: `turn-${id}` },
    raw: input.raw,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-conversation-admission-"));
  originalButlerData = process.env.BUTLER_DATA;
  process.env.BUTLER_DATA = tempDir;
});

afterEach(() => {
  if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalButlerData;
  rmSync(tempDir, { recursive: true, force: true });
});

function createLifecycle(input: {
  runtime?: AgentRuntimeAdapter;
  conversationStore: AgentConversationStore;
  bindingStore: SessionBindingStore;
}): SessionLifecycleService {
  input.bindingStore.upsert({
    sessionId: "butler/main",
    role: "butler",
    projectId: "butler",
    workspacePath: "fixtures/butler-project",
    runtimeAdapterId: input.runtime?.id ?? "admission-runtime",
    modelProviderId: provider.id,
    modelRef: "openai/auto:codex-latest",
    transportBindings: [],
  });
  return new SessionLifecycleService({
    store: input.bindingStore,
    runtime: input.runtime ?? new AdmissionRuntime(),
    provider,
    systemPromptFactory: () => "You are Butler.",
    conversationWriter: input.conversationStore,
    conversationMetricsButlerData: tempDir,
  });
}

test("session actor admits user and final assistant while stream and progress audit rows stay non-semantic", async () => {
  const bindingStore = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const conversationStore = new AgentConversationStore({ butlerData: tempDir });
  const lifecycle = createLifecycle({
    bindingStore,
    conversationStore,
  });

  const actor = await lifecycle.getOrCreate("butler/main", "butler");
  const result = await actor.handleInbound(inbound("semantic", "hello"));
  expect(result).toMatchObject({
    text: "final answer",
  });

  const session = conversationStore.getSessionByGatewayBinding("mock", "butler/main");
  expect(session?.project_id).toBe("butler");
  const semanticTail = conversationStore.readSemanticTail(session!.id, 10);
  expect(semanticTail.map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ]);
  expect(semanticTail[0]?.parts[0]?.content_json).toEqual({ text: "hello" });
  expect(semanticTail[1]?.parts[0]?.content_json).toEqual({ text: "final answer" });
  expect(readTranscript("butler/main").length).toBeGreaterThan(semanticTail.length);

  conversationStore.close();
  bindingStore.close();
});

test("cross-gateway turns share one canonical conversation session", async () => {
  const bindingStore = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const conversationStore = new AgentConversationStore({ butlerData: tempDir });
  const lifecycle = createLifecycle({ bindingStore, conversationStore });
  const actor = await lifecycle.getOrCreate("butler/main", "butler");

  await actor.handleInbound(inbound("app", "from app", { transport: "app" }));
  await actor.handleInbound(inbound("telegram", "from telegram", { transport: "telegram" }));

  const appSession = conversationStore.getSessionByGatewayBinding("app", "butler/main");
  const telegramSession = conversationStore.getSessionByGatewayBinding("telegram", "butler/main");
  expect(appSession?.id).toBeTruthy();
  expect(telegramSession?.id).toBe(appSession?.id);
  expect(conversationStore.readSemanticTail(appSession!.id, 10).map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
  ]);

  conversationStore.close();
  bindingStore.close();
});

test("system worker completion envelopes remain audit-only", async () => {
  const bindingStore = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const conversationStore = new AgentConversationStore({ butlerData: tempDir });
  const lifecycle = createLifecycle({ bindingStore, conversationStore });
  const actor = await lifecycle.getOrCreate("butler/main", "butler");

  await actor.handleInbound(inbound("worker-complete", [
    "System event: a background worker task completed.",
    "This is not a user request to start new work.",
    "Worker result: internal text",
  ].join("\n"), {
    transport: "system",
    senderId: "butler-worker-monitor",
  }));

  expect(conversationStore.getSessionByGatewayBinding("system", "butler/main")).toBeNull();
  expect(readTranscript("butler/main").length).toBeGreaterThan(0);

  conversationStore.close();
  bindingStore.close();
});

test("same-logical-turn continuation can still admit final assistant output", async () => {
  const bindingStore = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const conversationStore = new AgentConversationStore({ butlerData: tempDir });
  const lifecycle = createLifecycle({ bindingStore, conversationStore });
  const actor = await lifecycle.getOrCreate("butler/main", "butler");

  await actor.handleInbound(inbound("continuation", "continue", {
    raw: {
      sameLogicalTurnContinuation: true,
      contextAtomId: "turn-context-1",
    },
  }));

  const session = conversationStore.getSessionByGatewayBinding("mock", "butler/main");
  expect(session?.id).toBeTruthy();
  expect(conversationStore.readSemanticTail(session!.id, 10).map((message) => message.role)).toEqual([
    "assistant",
  ]);
  expect(conversationStore.readSemanticTail(session!.id, 10)[0]?.parts[0]?.content_json).toEqual({
    text: "final answer",
  });

  conversationStore.close();
  bindingStore.close();
});
