import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConversationStore } from
  "../../packages/butler-agent/src/agent/conversation/store.ts";
import { PromptAssembler } from
  "../../packages/butler-agent/src/agent/prompt/prompt-assembler.ts";
import type { InboundEnvelope } from
  "../../packages/butler-agent/src/gateways/core/contracts.ts";
import { BtccGatewaySessionActor } from
  "../../packages/butler-agent/src/interfaces/gateway/btcc/btcc-session-actor.ts";
import { SessionBindingStore } from
  "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { ScriptedBtccGatewayRuntime } from "./support/fake-btcc-gateway-runtime.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("BTCC gateway commits each Turn and gives the next Turn recent conversation", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "btcc-gateway-conversation-"));
  roots.push(butlerData);
  const bindingStore = new SessionBindingStore(
    join(butlerData, "runtime", "session-store.sqlite"),
  );
  const binding = bindingStore.upsert({
    sessionId: "butler/app-chat-continuity",
    role: "butler",
    workspacePath: process.cwd(),
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.6-sol",
    transportBindings: [],
  });
  const conversationStore = new AgentConversationStore({ butlerData });
  const runtime = new ScriptedBtccGatewayRuntime((command) =>
    command.kind === "run" && command.turnId === "turn-1"
      ? "첫 번째 점검 결과"
      : "이어서 완료했습니다",
  );
  const actor = new BtccGatewaySessionActor({
    binding,
    store: bindingStore,
    conversationStore,
    butlerData,
    runtime: runtime.runtime,
    contextDocuments: runtime.contextDocuments,
    observeTurn: runtime.observeTurn.bind(runtime),
    promptAssembler: new PromptAssembler({
      butlerHome: process.cwd(),
      butlerData,
    }),
  });

  try {
    await actor.handleInbound(envelope("turn-1", "message-1", "정적 import 경로를 점검해 주세요."));
    await actor.handleInbound(envelope("turn-2", "message-2", "방금 점검을 이어서 진행해 주세요."));

    const second = runtime.commands[1];
    expect(second?.kind).toBe("run");
    if (!second || second.kind !== "run") throw new Error("second BTCC command missing");
    const recentRef = second.context.mandatoryHotCacheRefs.find((ref) =>
      ref.endsWith(":recent-conversation"),
    );
    expect(recentRef).toBeDefined();
    const recent = runtime.persistedContextDocuments.get(recentRef!);
    expect(recent?.content).toContain("정적 import 경로를 점검해 주세요.");
    expect(recent?.content).toContain("첫 번째 점검 결과");

    const session = conversationStore.getSessionByGatewayBinding(
      "app",
      binding.sessionId,
    );
    expect(session).not.toBeNull();
    const messages = conversationStore.readMessages({ sessionId: session!.id });
    expect(messages).toHaveLength(4);
    expect(conversationStore.readTurn("turn-1")?.status).toBe("complete");
    expect(conversationStore.readTurn("turn-2")?.status).toBe("complete");
  } finally {
    conversationStore.close();
    bindingStore.close();
  }
});

test("BTCC gateway delivery survives optional session title failure", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "btcc-gateway-title-failure-"));
  roots.push(butlerData);
  const bindingStore = new SessionBindingStore(
    join(butlerData, "runtime", "session-store.sqlite"),
  );
  const binding = bindingStore.upsert({
    sessionId: "butler/app-chat-title-failure",
    role: "butler",
    workspacePath: process.cwd(),
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.6-sol",
    transportBindings: [],
  });
  const conversationStore = new AgentConversationStore({ butlerData });
  const runtime = new ScriptedBtccGatewayRuntime(() =>
    "요청을 처리하는 중 일시적인 문제가 발생했습니다.",
  );
  const actor = new BtccGatewaySessionActor({
    binding,
    store: bindingStore,
    conversationStore,
    butlerData,
    runtime: runtime.runtime,
    contextDocuments: runtime.contextDocuments,
    observeTurn: runtime.observeTurn.bind(runtime),
    promptAssembler: new PromptAssembler({
      butlerHome: process.cwd(),
      butlerData,
    }),
    async generateSessionTitle() {
      throw new Error("provider rate limited optional title generation");
    },
  });

  try {
    const result = await actor.handleInbound(
      envelope("turn-title-failure", "message-title-failure", "페이지를 만들어 주세요."),
    );

    expect(result.text).toBe("요청을 처리하는 중 일시적인 문제가 발생했습니다.");
    expect(result.generatedSessionTitle).toBeNull();
    const session = conversationStore.getSessionByGatewayBinding(
      "app",
      binding.sessionId,
    );
    expect(session).not.toBeNull();
    expect(conversationStore.readTurn("turn-title-failure")?.status).toBe("complete");
    expect(conversationStore.readMessages({ sessionId: session!.id })).toHaveLength(2);
  } finally {
    conversationStore.close();
    bindingStore.close();
  }
});

test("BTCC gateway replay does not call the model for an optional title", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "btcc-gateway-title-replay-"));
  roots.push(butlerData);
  const bindingStore = new SessionBindingStore(
    join(butlerData, "runtime", "session-store.sqlite"),
  );
  const binding = bindingStore.upsert({
    sessionId: "butler/app-chat-title-replay",
    role: "butler",
    workspacePath: process.cwd(),
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.6-sol",
    transportBindings: [],
  });
  const conversationStore = new AgentConversationStore({ butlerData });
  const runtime = new ScriptedBtccGatewayRuntime(() => "저장된 최종 답변");
  let titleCalls = 0;
  const actor = new BtccGatewaySessionActor({
    binding,
    store: bindingStore,
    conversationStore,
    butlerData,
    runtime: runtime.runtime,
    contextDocuments: runtime.contextDocuments,
    observeTurn: runtime.observeTurn.bind(runtime),
    promptAssembler: new PromptAssembler({
      butlerHome: process.cwd(),
      butlerData,
    }),
    async generateSessionTitle() {
      titleCalls += 1;
      return "호출되면 안 됨";
    },
  });

  try {
    const inbound = envelope(
      "turn-title-replay",
      "message-title-replay",
      "이전 답변을 복구해 주세요.",
    );
    const result = await actor.handleInbound({
      ...inbound,
      raw: { btccResume: true },
    });

    expect(runtime.commands[0]?.kind).toBe("resume");
    expect(result.text).toBe("저장된 최종 답변");
    expect(result.generatedSessionTitle).toBeNull();
    expect(titleCalls).toBe(0);
  } finally {
    conversationStore.close();
    bindingStore.close();
  }
});

function envelope(turnId: string, messageId: string, text: string): InboundEnvelope {
  return {
    eventId: `event-${messageId}`,
    transport: "app",
    accountId: "local",
    peer: { kind: "dm", id: "app-chat-continuity" },
    sender: { id: "local-principal" },
    message: {
      id: messageId,
      text,
      timestamp: "2026-07-28T00:00:00.000Z",
    },
    routingHints: {
      sessionId: "butler/app-chat-continuity",
      turnId,
    },
  };
}
