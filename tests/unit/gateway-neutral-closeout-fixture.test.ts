import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactTranscript } from "../../packages/butler-agent/src/agent/context/compaction.ts";
import { conversationSessionIdForDurableSession } from "../../packages/butler-agent/src/agent/conversation/session-admission.ts";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import type { RuntimeTurnEventInput } from "../../packages/butler-agent/src/agent/events/turn-events.ts";
import { deliveredDeliveryState } from "../../packages/butler-agent/src/agent/turn/runtime-delivery-state.ts";
import { createGatewayServer } from "../../packages/butler-agent/src/gateways/core/server.ts";
import { GatewayRouter } from "../../packages/butler-agent/src/gateways/core/router.ts";
import { AppServerStore } from "../../packages/butler-agent/src/gateways/app/application/store/app-server-store.ts";
import { appTurnEventAction } from "../../packages/butler-agent/src/interfaces/gateway/native-butler-bootstrap.ts";
import { SessionLifecycleService, createLifecycleGatewayHandlers } from "../../packages/butler-agent/src/interfaces/gateway/session-lifecycle.ts";
import { DeliveryGuard } from "../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts";
import { MockTransportAdapter } from "../../packages/butler-agent/src/interfaces/transport/mock/adapter.ts";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { readTranscript } from "../../packages/butler-agent/src/test-support/harness/transcripts.ts";
import type {
  AgentRuntimeAdapter,
  InboundEnvelope,
  ModelInvocation,
  ModelProviderAdapter,
  OutboundAction,
  RuntimeSessionHandle,
  RuntimeSessionInit,
  RuntimeTurnInput,
} from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

let tempDir = "";
let originalButlerData: string | undefined;

const RUNTIME_SESSION_ID = "butler/main";
const CANONICAL_SESSION_ID = conversationSessionIdForDurableSession(RUNTIME_SESSION_ID);
const FINAL_TEXT = "closeout final answer";
const RAW_SECRET = "SECRET_CLOSEOUT_RAW_PAYLOAD";
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

const provider: ModelProviderAdapter = {
  id: "closeout-provider",
  capabilities: {
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsImages: false,
    supportsAudio: false,
    supportsServerThreads: false,
    supportsReasoningConfig: true,
    supportsPromptCaching: false,
  },
  async invoke(input: ModelInvocation) {
    if (input.metadata?.purpose === "app_opening_decision") {
      return {
        text: JSON.stringify({
          summary: "요청을 접수했습니다.",
          rationale: "앱 게이트웨이 closeout fixture가 공개 진행 상태를 검증합니다.",
          nextStep: "스트림과 도구 이벤트를 처리합니다.",
        }),
      };
    }
    return { text: "unused" };
  },
};

class CloseoutRuntime implements AgentRuntimeAdapter {
  readonly id = "closeout-runtime";
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
    for (let index = 0; index < 12; index += 1) {
      await input.emitTurnEvent?.({
        kind: "model.stream.text_delta",
        payload: {
          streamId: "stream-closeout",
          textDelta: `delta-${index}`,
          target: "final_candidate",
          sequence: index + 1,
        },
      });
    }
    await input.emitTurnEvent?.({
      kind: "model.stream.tool_call_delta",
      visibility: "internal",
      payload: {
        streamId: "stream-closeout",
        callIndex: 0,
        sequence: 13,
        toolCallId: "tool-closeout-1",
        safeToolName: "read_file",
        argumentCharCount: 18,
        rawArgumentsDelta: `{"secret":"${RAW_SECRET}"}`,
        publicState: "generating",
      },
    });
    await input.emitTurnEvent?.(toolCallFinalized());
    await input.emitIntermediateDelivery?.(toolProgressAction(), {
      source: "gateway-neutral-closeout-fixture#tool-progress",
    });
    await input.emitTurnEvent?.({
      kind: "tool.started",
      payload: {
        toolCallId: "tool-closeout-1",
        toolName: "read_file",
        safeLabel: "Reading fixture",
      },
    });
    await input.emitTurnEvent?.({
      kind: "tool.progress",
      payload: {
        toolCallId: "tool-closeout-1",
        safeLabel: `Read in progress token=${RAW_SECRET}`,
      },
    });
    await input.emitTurnEvent?.({
      kind: "tool.completed",
      payload: {
        toolCallId: "tool-closeout-1",
        toolName: "read_file",
        safeLabel: "Read complete",
      },
    });
    await input.emitTurnEvent?.(toolResultFinalized());
    await input.emitTurnEvent?.({
      kind: "message.final.completed",
      payload: {
        safeLabel: "Final answer ready",
      },
    });
    await input.emitTurnEvent?.({
      kind: "model.stream.completed",
      payload: {
        streamId: "stream-closeout",
        status: "completed",
      },
    });
    return {
      text: FINAL_TEXT,
      delivery: deliveredDeliveryState(),
    };
  }
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-gncc-closeout-fixture-"));
  originalButlerData = process.env.BUTLER_DATA;
  process.env.BUTLER_DATA = tempDir;
});

afterEach(() => {
  if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalButlerData;
  rmSync(tempDir, { recursive: true, force: true });
});

test("gateway-neutral closeout fixture keeps stream, progress, delivery, and tool audit outside semantic messages", async () => {
  const bindingStore = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const conversationStore = new AgentConversationStore({ butlerData: tempDir });
  const mock = new MockTransportAdapter({ id: "app" });
  const deliveryGuard = new DeliveryGuard({ adapters: [mock] });
  bindingStore.upsert({
    sessionId: RUNTIME_SESSION_ID,
    role: "butler",
    projectId: "butler",
    workspacePath: "fixtures/butler-project",
    runtimeAdapterId: "closeout-runtime",
    modelProviderId: provider.id,
    modelRef: "openai/test",
    transportBindings: [{
      transport: "app",
      accountId: "default",
      peerId: "peer-closeout",
    }],
  });
  const lifecycle = new SessionLifecycleService({
    store: bindingStore,
    runtime: new CloseoutRuntime(),
    provider,
    conversationWriter: conversationStore,
    conversationMetricsButlerData: tempDir,
    sessionTitleGenerator: false,
    systemPromptFactory: () => "You are Butler.",
    deliverIntermediate: async ({ binding, action, metadata }) => {
      await deliveryGuard.deliver(binding.sessionId, action, metadata);
    },
    deliverTurnEvent: async ({ binding, envelope, event }) => {
      const action = appTurnEventAction({
        sessionId: binding.sessionId,
        envelope,
        event,
      });
      if (!action) return;
      const delivery = await deliveryGuard.deliver(binding.sessionId, action, {
        source: "gateway-neutral-closeout-fixture#turn-event",
        kind: "turn_event",
      });
      if (!delivery.ok) throw new Error(delivery.error || "turn event delivery failed");
    },
  });
  const server = createGatewayServer({
    router: new GatewayRouter({ store: bindingStore }),
    handlers: createLifecycleGatewayHandlers(lifecycle),
  });
  await mock.start(async (event) => {
    const result = await server.handleInbound(event);
    expect(result.status).toBe("handled");
    if (result.status !== "handled") return;
    const text = result.handlerResult.metadata?.text;
    expect(text).toBe(FINAL_TEXT);
    await deliveryGuard.deliver(result.route.sessionId, finalDeliveryAction(event, String(text)), {
      source: "gateway-neutral-closeout-fixture#final-delivery",
    });
  });

  await mock.emit(inbound("gncc-closeout", "검증 fixture를 실행해 주세요."));

  const semanticMessages = conversationStore.readMessages({
    sessionId: CANONICAL_SESSION_ID,
    includeCompacted: true,
    limit: 20,
  });
  const transcriptEvents = readTranscript(RUNTIME_SESSION_ID);
  expect(transcriptEvents.length).toBeGreaterThan(30);
  expect(transcriptEvents.filter((event) => event.kind === "delivery").length).toBeGreaterThan(10);
  expect(semanticMessages).toHaveLength(3);
  expect(semanticMessages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "assistant",
  ]);
  expect(semanticMessages[1]?.parts.map((part) => part.kind)).toEqual([
    "tool_call",
    "tool_result",
  ]);
  expect(semanticMessages[2]?.parts[0]?.content_json).toEqual({ text: FINAL_TEXT });
  expect(JSON.stringify(conversationStore.readPromptMaterial({ sessionId: CANONICAL_SESSION_ID })))
    .not.toContain(RAW_SECRET);
  expect(JSON.stringify(semanticMessages)).not.toContain(RAW_SECRET);
  expect(JSON.stringify(mock.sentActions)).not.toContain(RAW_SECRET);
  expect(JSON.stringify(transcriptEvents)).not.toContain(RAW_SECRET);

  const appStore = new AppServerStore({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    conversationProjectionReader: conversationStore,
  });
  expect(appStore.replayConversationProjection()).toMatchObject({
    ok: true,
    pending_count: 0,
    projected_messages: 2,
  });
  expect(appStore.listConversationProjectionMessages(CANONICAL_SESSION_ID).map((message) => ({
    role: message.role,
    text: message.text,
    conversation_message_id: message.conversation_message_id,
  }))).toEqual(expect.arrayContaining([
    {
      role: "user",
      text: "검증 fixture를 실행해 주세요.",
      conversation_message_id: semanticMessages[0]?.id,
    },
    {
      role: "assistant",
      text: FINAL_TEXT,
      conversation_message_id: semanticMessages[2]?.id,
    },
  ]));
  expect(appStore.rebuildConversationProjection(CANONICAL_SESSION_ID)).toMatchObject({
    ok: true,
    conversation_session_id: CANONICAL_SESSION_ID,
    projected_messages: 2,
  });

  const compaction = await compactTranscript({
    butlerData: tempDir,
    sessionId: RUNTIME_SESSION_ID,
    trigger: "manual",
    preserveLastMessages: 2,
  });
  expect(compaction.status).toBe("ok");
  expect(compaction.summarized_event_range.event_count).toBeLessThanOrEqual(semanticMessages.length);
  expect(compaction.summarized_event_range.event_count).toBeLessThan(transcriptEvents.length);

  appStore.db.close();
  conversationStore.close();
  bindingStore.close();
});

function toolCallFinalized(): RuntimeTurnEventInput {
  return {
    kind: "tool_call.finalized",
    visibility: "internal",
    payload: {
      toolCallId: "tool-closeout-1",
      toolName: "read_file",
      arguments: SAFE_ARGUMENTS,
      contentJson: {
        rawArguments: `{"secret":"${RAW_SECRET}"}`,
      },
    },
  };
}

function toolResultFinalized(): RuntimeTurnEventInput {
  return {
    kind: "tool_result.finalized",
    visibility: "internal",
    payload: {
      toolCallId: "tool-closeout-1",
      toolName: "read_file",
      ok: true,
      result: SAFE_RESULT,
      contentJson: {
        stdout: RAW_SECRET,
      },
    },
  };
}

function toolProgressAction(): OutboundAction {
  return {
    actionId: "closeout-tool-progress",
    transport: "app",
    accountId: "default",
    peer: { kind: "dm", id: "peer-closeout" },
    message: {
      text: "",
      replyToMessageId: "gncc-closeout",
    },
    metadata: {
      kind: "tool_progress",
      toolCallId: "tool-closeout-1",
      toolName: "read_file",
      safeLabel: "Reading fixture",
      state: "running",
      activityKind: "read",
    },
  };
}

function finalDeliveryAction(envelope: InboundEnvelope, text: string): OutboundAction {
  return {
    actionId: `closeout-final:${envelope.eventId}`,
    transport: "app",
    accountId: envelope.accountId,
    peer: envelope.peer,
    message: {
      text,
      replyToMessageId: envelope.message.id,
    },
    metadata: {
      kind: "final_result",
      turnId: envelope.routingHints?.turnId,
      sessionId: RUNTIME_SESSION_ID,
    },
  };
}

function inbound(id: string, text: string): InboundEnvelope {
  return {
    eventId: `app:${id}`,
    transport: "app",
    accountId: "default",
    peer: { kind: "dm", id: "peer-closeout" },
    sender: { id: "user-closeout", displayName: "GNCC Closeout" },
    message: {
      id,
      text,
      timestamp: "2026-07-02T00:00:00.000Z",
    },
    routingHints: {
      turnId: `turn-${id}`,
    },
  };
}
