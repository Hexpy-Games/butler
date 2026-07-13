import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConversationContext } from "../../packages/butler-agent/src/agent/context/conversation-context.ts";
import { conversationSessionIdForDurableSession } from "../../packages/butler-agent/src/agent/conversation/session-admission.ts";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { handleNativeStewardTelegramTurn } from "../../packages/butler-agent/src/interfaces/gateway/native-steward-bootstrap.ts";
import { SessionLifecycleService } from "../../packages/butler-agent/src/interfaces/gateway/session-lifecycle.ts";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { readTranscript } from "../../packages/butler-agent/src/test-support/harness/transcripts.ts";
import type {
  AgentRuntimeAdapter,
  InboundEnvelope,
  ModelProviderAdapter,
  RuntimeSessionHandle,
  RuntimeSessionInit,
  RuntimeTurnEventInput,
  RuntimeTurnInput,
} from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import { TurnSchedulerContinuationYieldError } from "../../packages/butler-agent/src/agent/turn/turn-continuation-context.ts";

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

const SAFE_ARGUMENTS = {
  schema_version: "butler.tool-call-arguments-transcript.v1",
  argument_keys: ["path"],
  safe_arguments: { path: "README.md" },
};

const SAFE_RESULT = {
  schema_version: "butler.tool-result-evidence-transcript.v1",
  evidence_capability_receipts: [],
  evidence_receipts: [],
  evidence_limitations: [],
  completion_obligation_evidence: {
    outcome: "satisfied",
    satisfied: [],
    missing_critical: [],
    missing_non_critical: [],
    limitations: [],
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

class FinalizedToolRuntime implements AgentRuntimeAdapter {
  readonly id = "finalized-tool-runtime";
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
      kind: "tool_call.finalized",
      visibility: "internal",
      payload: {
        toolCallId: "tool-finalized-1",
        toolName: "read_file",
        arguments: SAFE_ARGUMENTS,
        contentJson: {
          name: "SECRET_TOKEN_123",
          arguments: { token: "SECRET_TOKEN_123" },
          rawArguments: "{\"token\":\"SECRET_TOKEN_123\"}",
        },
      },
    });
    await input.emitTurnEvent?.({
      kind: "tool.started",
      payload: {
        toolCallId: "tool-finalized-1",
        toolName: "Read File",
        safeLabel: "Reading file",
      },
    });
    await input.emitTurnEvent?.({
      kind: "tool.completed",
      payload: {
        toolCallId: "tool-finalized-1",
        toolName: "Read File",
        safeLabel: "Read complete",
      },
    });
    await input.emitTurnEvent?.({
      kind: "tool_result.finalized",
      visibility: "internal",
      payload: {
        toolCallId: "tool-finalized-1",
        toolName: "read_file",
        ok: true,
        result: SAFE_RESULT,
        contentJson: {
          name: "SECRET_TOKEN_123",
          result: { text: "SECRET_TOKEN_123" },
        },
      },
    });
    return { text: "final with tool" };
  }
}

class UnsafeFinalizedToolRuntime implements AgentRuntimeAdapter {
  readonly id = "unsafe-finalized-tool-runtime";
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
      kind: "tool_call.finalized",
      payload: {
        toolCallId: "tool-unsafe-1",
        contentJson: {
          rawArguments: "{\"secret\":true}",
        },
      },
    });
    return { text: "final without unsafe tool admission" };
  }
}

class StewardBootstrapRuntime implements AgentRuntimeAdapter {
  readonly id = "steward-bootstrap-runtime";
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

  async runTurn(input: RuntimeTurnInput) {
    expect(input.handle.role).toBe("steward");
    return { text: "steward final answer" };
  }
}

class CheckpointYieldRuntime implements AgentRuntimeAdapter {
  readonly id = "checkpoint-yield-runtime";
  readonly capabilities = {
    supportsSessionResume: false,
    supportsCompaction: false,
    supportsToolStreaming: true,
    supportsParallelToolCalls: false,
  } as const;
  private calls = 0;

  async createSession(input: RuntimeSessionInit): Promise<RuntimeSessionHandle> {
    return {
      sessionId: input.sessionId,
      role: input.role,
      runtimeAdapterId: this.id,
    };
  }

  async runTurn(input: RuntimeTurnInput) {
    this.calls += 1;
    if (this.calls === 1) {
      throw new TurnSchedulerContinuationYieldError(
        input.handle.sessionId,
        "turn-checkpoint-yield",
        "checkpoint-context.json",
        "checkpoint-context.json:g1",
        1,
      );
    }
    return { text: "continued final answer" };
  }
}

class CancelledRuntime implements AgentRuntimeAdapter {
  readonly id: string = "cancelled-runtime";
  readonly capabilities = {
    supportsSessionResume: false,
    supportsCompaction: false,
    supportsToolStreaming: false,
    supportsParallelToolCalls: false,
  } as const;

  async createSession(input: RuntimeSessionInit): Promise<RuntimeSessionHandle> {
    return { sessionId: input.sessionId, role: input.role, runtimeAdapterId: this.id };
  }

  async runTurn(): Promise<never> {
    const error = new Error("cancelled by principal");
    error.name = "AbortError";
    throw error;
  }
}

class FailedRuntime extends CancelledRuntime {
  override readonly id = "failed-runtime";

  override async runTurn(): Promise<never> {
    throw new Error("runtime failed");
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

function textPartContent(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as { text?: unknown }).text;
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
  deliverTurnEvent?: (input: { event: RuntimeTurnEventInput }) => Promise<void>;
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
    deliverTurnEvent: input.deliverTurnEvent,
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
  expect(conversationStore.readTurnOutcome("turn-semantic")).toMatchObject({
    generation: 1,
    outcome: "delivered",
    request_message_id: semanticTail[0]?.id,
    public_assistant_message_id: semanticTail[1]?.id,
    model_ref: "openai/auto:codex-latest",
  });
  expect(readTranscript("butler/main").length).toBeGreaterThan(semanticTail.length);

  conversationStore.close();
  bindingStore.close();
});

test("session actor admits finalized tool events without projecting internal payloads", async () => {
  const bindingStore = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const conversationStore = new AgentConversationStore({ butlerData: tempDir });
  const deliveredKinds: string[] = [];
  const lifecycle = createLifecycle({
    bindingStore,
    conversationStore,
    runtime: new FinalizedToolRuntime(),
    deliverTurnEvent: async ({ event }) => {
      deliveredKinds.push(event.kind);
    },
  });
  const actor = await lifecycle.getOrCreate("butler/main", "butler");

  await actor.handleInbound(inbound("finalized-tool", "use a tool"));

  const session = conversationStore.getSessionByGatewayBinding("mock", "butler/main");
  const semanticTail = conversationStore.readSemanticTail(session!.id, 10);
  expect(semanticTail.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "assistant",
  ]);
  expect(semanticTail[1]?.parts.map((part) => part.kind)).toEqual([
    "tool_call",
    "tool_result",
  ]);
  expect(semanticTail[1]?.parts[0]?.content_json).toEqual({
    eventKind: "tool_call.finalized",
    toolCallId: "tool-finalized-1",
    safeToolName: "read_file",
    arguments: SAFE_ARGUMENTS,
  });
  expect(semanticTail[1]?.parts[1]?.content_json).toEqual({
    eventKind: "tool_result.finalized",
    toolCallId: "tool-finalized-1",
    safeToolName: "read_file",
    ok: true,
    result: SAFE_RESULT,
  });
  const promptMaterial = conversationStore.readPromptMaterial({ sessionId: session!.id });
  expect(JSON.stringify(promptMaterial)).not.toContain("SECRET_TOKEN_123");
  expect(JSON.stringify(promptMaterial)).not.toContain("rawArguments");
  expect(deliveredKinds).toEqual(["tool.started", "tool.completed"]);

  conversationStore.close();
  bindingStore.close();
});

test("session actor blocks finalized tool events when internal visibility is omitted", async () => {
  const bindingStore = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const conversationStore = new AgentConversationStore({ butlerData: tempDir });
  const deliveredKinds: string[] = [];
  const lifecycle = createLifecycle({
    bindingStore,
    conversationStore,
    runtime: new UnsafeFinalizedToolRuntime(),
    deliverTurnEvent: async ({ event }) => {
      deliveredKinds.push(event.kind);
    },
  });
  const actor = await lifecycle.getOrCreate("butler/main", "butler");

  await actor.handleInbound(inbound("unsafe-finalized-tool", "use unsafe tool"));

  const session = conversationStore.getSessionByGatewayBinding("mock", "butler/main");
  const semanticTail = conversationStore.readSemanticTail(session!.id, 10);
  expect(semanticTail.map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ]);
  expect(semanticTail.flatMap((message) => message.parts.map((part) => part.kind))).toEqual([
    "text",
    "text",
  ]);
  expect(deliveredKinds).toEqual([]);

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

test("standalone steward bootstrap writes semantic rows to canonical conversation store", async () => {
  const workspacePath = join(tempDir, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(
    join(tempDir, "butler.config.json"),
    JSON.stringify({
      projects: [{
        name: "butler",
        path: workspacePath,
      }],
    }),
  );

  const result = await handleNativeStewardTelegramTurn({
    projectName: "butler",
    workspacePath,
    message: "steward bootstrap question",
    chatId: "group-1",
    threadId: "topic-1",
    messageId: "message-1",
    senderId: "principal-1",
    butlerHome: tempDir,
    butlerData: tempDir,
    runtime: new StewardBootstrapRuntime(),
    provider,
    sendTelegram: async ({ text }) => ({
      ok: true,
      transportMessageId: `telegram-${text.length}`,
    }),
  });

  expect(result).toMatchObject({
    sessionId: "steward/butler",
    text: "steward final answer",
    delivery: {
      ok: true,
    },
  });

  const conversationStore = new AgentConversationStore({ butlerData: tempDir });
  const canonicalSessionId = conversationSessionIdForDurableSession(result.sessionId);
  const session = conversationStore.getSessionByGatewayBinding("telegram", result.sessionId);
  expect(session).toMatchObject({
    id: canonicalSessionId,
    project_id: "butler",
  });
  expect(conversationStore.readSemanticTail(canonicalSessionId, 10).map((message) => ({
    role: message.role,
    text: textPartContent(message.parts[0]?.content_json),
    sourceGateway: message.source_gateway,
  }))).toEqual([
    {
      role: "user",
      text: "steward bootstrap question",
      sourceGateway: "telegram",
    },
    {
      role: "assistant",
      text: "steward final answer",
      sourceGateway: "telegram",
    },
  ]);

  const context = readConversationContext({
    butlerData: tempDir,
    sessionId: result.sessionId,
    query: "bootstrap",
    limit: 5,
    maxChars: 1000,
  });
  expect(context.ok).toBe(true);
  expect(context.session_id).toBe(canonicalSessionId);
  expect(context.messages.map((message) => message.text)).toEqual([
    "steward bootstrap question",
    "steward final answer",
  ]);

  conversationStore.close();
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

test("scheduler yield keeps the conversation turn open until the resumed final", async () => {
  const bindingStore = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const conversationStore = new AgentConversationStore({ butlerData: tempDir });
  const lifecycle = createLifecycle({
    bindingStore,
    conversationStore,
    runtime: new CheckpointYieldRuntime(),
  });
  const actor = await lifecycle.getOrCreate("butler/main", "butler");

  await expect(actor.handleInbound(inbound("checkpoint-yield", "continue durable work")))
    .rejects.toThrow("Turn scheduler yielded");
  expect(conversationStore.readTurn("turn-checkpoint-yield")?.status).toBe("running");
  expect(conversationStore.readTurnOutcome("turn-checkpoint-yield")).toMatchObject({
    generation: 1,
    outcome: "recoverable",
    safe_code: "turn_scheduler_continuation_yield",
    continuation: { logical_turn_id: "turn-checkpoint-yield" },
  });
  const yieldEvents = readTranscript("butler/main");
  expect(yieldEvents.some((event) =>
    event.kind === "system" && event.payload.category === "runtime_error",
  )).toBe(false);
  expect(yieldEvents.some((event) =>
    event.kind === "session_status" && event.payload.reason === "gateway-turn-continuing",
  )).toBe(true);

  await actor.handleInbound(inbound("checkpoint-yield", "continue durable work", {
    raw: {
      sameLogicalTurnContinuation: true,
      contextAtomId: "checkpoint-context.json",
      checkpointId: "checkpoint-context.json:g1",
      schedulerItemId: "queue-checkpoint-1",
    },
  }));
  expect(conversationStore.readTurn("turn-checkpoint-yield")?.status).toBe("complete");
  expect(conversationStore.readTurnOutcome("turn-checkpoint-yield")).toMatchObject({
    generation: 2,
    outcome: "delivered",
  });
  const session = conversationStore.getSessionByGatewayBinding("mock", "butler/main");
  expect(conversationStore.readSemanticTail(session!.id, 10).map((message) => message.role))
    .toEqual(["user", "assistant"]);

  conversationStore.close();
  bindingStore.close();
});

test("principal cancellation writes one terminal cancelled outcome capsule", async () => {
  const bindingStore = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const conversationStore = new AgentConversationStore({ butlerData: tempDir });
  const lifecycle = createLifecycle({
    bindingStore,
    conversationStore,
    runtime: new CancelledRuntime(),
  });
  const actor = await lifecycle.getOrCreate("butler/main", "butler");

  await expect(actor.handleInbound(inbound("cancelled", "stop now")))
    .rejects.toThrow("cancelled by principal");
  expect(conversationStore.readTurn("turn-cancelled")).toMatchObject({ status: "aborted" });
  expect(conversationStore.readTurnOutcome("turn-cancelled")).toMatchObject({
    generation: 1,
    outcome: "cancelled",
    safe_code: "turn_aborted",
  });

  conversationStore.close();
  bindingStore.close();
});

test("ordinary terminal failure writes a failed outcome capsule", async () => {
  const bindingStore = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const conversationStore = new AgentConversationStore({ butlerData: tempDir });
  const lifecycle = createLifecycle({
    bindingStore,
    conversationStore,
    runtime: new FailedRuntime(),
  });
  const actor = await lifecycle.getOrCreate("butler/main", "butler");

  await expect(actor.handleInbound(inbound("failed", "do work"))).rejects.toThrow("runtime failed");
  expect(conversationStore.readTurnOutcome("turn-failed")).toMatchObject({
    generation: 1,
    outcome: "failed",
    safe_code: "turn_failed",
  });

  conversationStore.close();
  bindingStore.close();
});
