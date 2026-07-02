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
      timestamp: "2026-07-02T00:00:00.000Z",
    },
    routingHints: { turnId: `turn-${id}` },
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

test("session actor admits semantic rows while stream and progress audit rows stay non-semantic", async () => {
  const bindingStore = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const conversationStore = new AgentConversationStore({ butlerData: tempDir });
  bindingStore.upsert({
    sessionId: "butler/main",
    role: "butler",
    projectId: "butler",
    workspacePath: "fixtures/butler-project",
    runtimeAdapterId: "admission-runtime",
    modelProviderId: provider.id,
    modelRef: "openai/auto:codex-latest",
    transportBindings: [],
  });
  const lifecycle = new SessionLifecycleService({
    store: bindingStore,
    runtime: new AdmissionRuntime(),
    provider,
    systemPromptFactory: () => "You are Butler.",
    conversationWriter: conversationStore,
    conversationMetricsButlerData: tempDir,
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
    "assistant",
  ]);
  expect(semanticTail[0]?.parts[0]?.content_json).toEqual({ text: "hello" });
  expect(semanticTail[1]?.parts.map((part) => part.kind)).toEqual([
    "tool_call",
    "tool_result",
  ]);
  expect(semanticTail[2]?.parts[0]?.content_json).toEqual({ text: "final answer" });
  expect(readTranscript("butler/main").length).toBeGreaterThan(semanticTail.length);

  conversationStore.close();
  bindingStore.close();
});
