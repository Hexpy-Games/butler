import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBtcc } from
  "../../packages/butler-agent/src/agent/btcc/btcc.ts";
import { DefaultBtccTurnPreparation } from
  "../../packages/butler-agent/src/agent/btcc/turn/prepare-turn.ts";
import { AgentConversationStore } from
  "../../packages/butler-agent/src/agent/conversation/store.ts";
import { PromptAssembler } from
  "../../packages/butler-agent/src/agent/prompt/prompt-assembler.ts";
import type { GatewayRoute, InboundEnvelope } from
  "../../packages/butler-agent/src/gateways/core/contracts.ts";
import type { BtccRunCommand, BtccTurnRequest } from
  "../../packages/butler-agent/src/agent/btcc/index.ts";
import type { TurnRecord } from
  "../../packages/butler-agent/src/agent/btcc/turn/contracts.ts";
import { createBtccGatewayHandlers } from
  "../../packages/butler-agent/src/interfaces/gateway/btcc/create-btcc-gateway-handlers.ts";
import { SessionBindingStore } from
  "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { ScriptedBtccGatewayRuntime } from "./support/fake-btcc-gateway-runtime.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("fresh and replay ingress use the same BTCC public request and durable resume", async () => {
  const harness = createHarness("butler/inbound-admission");
  try {
    const handlers = createBtccGatewayHandlers({ btcc: harness.btcc });
    const route = harness.route;
    const input = envelope("turn-fresh", "message-fresh", "continue");
    await handlers.butler!({ envelope: input, route });
    const first = harness.runtime.commands[0];
    if (!first || first.kind !== "run") throw new Error("fresh run command missing");
    harness.admittedTurn.current = turnFromRunCommand(first);
    await handlers.butler!({ envelope: input, route });

    expect(harness.runtime.commands).toHaveLength(2);
    expect(harness.runtime.commands.map((command) => command.kind)).toEqual(["run", "resume"]);
    expect(input.raw).toBeUndefined();
  } finally {
    await harness.btcc.host.close();
    harness.conversations.close();
    harness.bindings.close();
  }
});

test("raw btccWake payloads cannot bypass the trusted wake producer", async () => {
  const harness = createHarness("butler/inbound-wake");
  try {
    const handlers = createBtccGatewayHandlers({ btcc: harness.btcc });
    await expect(handlers.butler!({
      envelope: {
        ...envelope("turn-wake", "message-wake", "wake with result"),
        raw: { btccWake: { sourceTurnId: "source-turn" } },
      },
      route: harness.route,
    })).rejects.toThrow("Raw btccWake is not an authorized BTCC ingress");
    expect(harness.runtime.commands).toHaveLength(0);
  } finally {
    await harness.btcc.host.close();
    harness.conversations.close();
    harness.bindings.close();
  }
});

test("typed wake admission fails closed when the durable authorization or scope is absent", async () => {
  const harness = createHarness("butler/inbound-wake-denied");
  try {
    const wake = typedWakeRequest(harness.route.sessionId, "turn-wake-denied", {
      triggerId: "trigger-denied",
      sourceTurnId: "source-turn",
      authorizationRef: "approval-denied",
      resultScopeRef: "worker-result-denied",
    });
    await expect(harness.btcc.runTurn(wake)).rejects.toThrow("BTCC authorized wake denied");

    harness.runtime.wakeAuthorizations.recordAuthorization({
      sourceTurnId: wake.trigger.kind === "authorized_wake" ? wake.trigger.sourceTurnId : "",
      authorizationRef: wake.trigger.kind === "authorized_wake" ? wake.trigger.authorizationRef : "",
      resultScopeRef: "different-result-scope",
    });
    await expect(harness.btcc.runTurn({
      ...wake,
      eventId: "event-wake-denied-2",
      turnId: "turn-wake-denied-2",
      message: { ...wake.message, id: "message-wake-denied-2" },
    })).rejects.toThrow("BTCC authorized wake denied");
    expect(harness.runtime.commands).toHaveLength(0);
  } finally {
    await harness.btcc.host.close();
    harness.conversations.close();
    harness.bindings.close();
  }
});

test("an admitted typed authorized wake replay does not require re-authorization", async () => {
  const harness = createHarness("butler/inbound-wake-replay");
  try {
    const input = typedWakeRequest(harness.route.sessionId, "turn-wake-replay", {
      triggerId: "trigger-replay",
      sourceTurnId: "source-replay",
      authorizationRef: "approval-replay",
      resultScopeRef: "result-replay",
    });
    harness.runtime.wakeAuthorizations.recordAuthorization({
      sourceTurnId: "source-replay",
      authorizationRef: "approval-replay",
      resultScopeRef: "result-replay",
    });
    await harness.btcc.runTurn(input);
    const first = harness.runtime.commands[0];
    if (!first || first.kind !== "wake") throw new Error("wake command missing");
    harness.admittedTurn.current = turnFromWakeCommand(first);
    harness.runtime.wakeAuthorizations.clear();

    await harness.btcc.runTurn(input);
    expect(harness.runtime.commands.map((command) => command.kind)).toEqual(["wake", "resume"]);
  } finally {
    await harness.btcc.host.close();
    harness.conversations.close();
    harness.bindings.close();
  }
});

function createHarness(sessionId: string) {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-inbound-admission-"));
  roots.push(butlerData);
  const bindings = new SessionBindingStore(
    join(butlerData, "runtime", "session-store.sqlite"),
  );
  const binding = bindings.upsert({
    sessionId,
    role: "butler",
    workspacePath: butlerData,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.6-sol",
    transportBindings: [],
  });
  const conversations = new AgentConversationStore({ butlerData });
  const runtime = new ScriptedBtccGatewayRuntime("wake result");
  const admittedTurn: { current: TurnRecord | null } = { current: null };
  const btcc = createBtcc({
    runtime: runtime.runtime,
    preparation: new DefaultBtccTurnPreparation({
      bindingStore: bindings,
      conversationStore: conversations,
      butlerData,
      promptAssembler: new PromptAssembler({ butlerHome: process.cwd(), butlerData }),
      contextDocuments: runtime.contextDocuments,
      turns: { findTurn: async () => admittedTurn.current },
      wakeAuthorizations: runtime.wakeAuthorizations,
    }),
    progressEvents: runtime.progressEvents,
    turns: { findTurn: async () => admittedTurn.current },
  });
  const route: GatewayRoute = {
    sessionId: binding.sessionId,
    role: "butler",
    reason: "session-hint",
    workspacePath: binding.workspacePath,
  };
  return { btcc, runtime, bindings, conversations, route, admittedTurn };
}

function turnFromWakeCommand(
  command: Extract<BtccRunCommand, { kind: "wake" }>,
): TurnRecord {
  return {
    turnId: command.turnId,
    sessionId: command.sessionId,
    inboxId: "inbox-wake-replay",
    triggerKey: command.triggerKey,
    originalMessageId: command.trigger.triggerId,
    originalMessage: command.trigger.content,
    wakeIdentity: {
      triggerId: command.trigger.triggerId,
      sourceTurnId: command.trigger.sourceTurnId,
      authorizationRef: command.trigger.authorizationRef,
      ...(command.trigger.resultScopeRef
        ? { resultScopeRef: command.trigger.resultScopeRef }
        : {}),
    },
    modelSelection: command.modelSelection,
    context: command.context,
    semanticState: "delivered",
    revision: 2,
    executionFence: 1,
  };
}

function turnFromRunCommand(
  command: Extract<BtccRunCommand, { kind: "run" }>,
): TurnRecord {
  return {
    turnId: command.turnId,
    sessionId: command.sessionId,
    inboxId: "inbox-run-replay",
    triggerKey: command.triggerKey,
    originalMessageId: command.message.messageId,
    originalMessage: command.message.content,
    modelSelection: command.modelSelection,
    context: command.context,
    semanticState: "delivered",
    revision: 2,
    executionFence: 1,
  };
}

function envelope(turnId: string, messageId: string, text: string): InboundEnvelope {
  return {
    eventId: `event-${messageId}`,
    transport: "app",
    accountId: "local",
    peer: { kind: "dm", id: "general" },
    sender: { id: "app-user" },
    message: {
      id: messageId,
      text,
      timestamp: "2026-07-28T00:00:00.000Z",
    },
    routingHints: { turnId },
  };
}

function typedWakeRequest(
  sessionId: string,
  turnId: string,
  input: {
    triggerId: string;
    sourceTurnId: string;
    authorizationRef: string;
    resultScopeRef?: string;
  },
): BtccTurnRequest {
  return {
    turnId,
    sessionId,
    eventId: `event-${turnId}`,
    transport: "app",
    accountId: "local",
    peer: { kind: "dm", id: "general" },
    sender: { id: "trusted-producer" },
    message: {
      id: `message-${turnId}`,
      content: "resume from the authorized worker result",
      timestamp: "2026-08-03T00:00:00.000Z",
    },
    trigger: {
      kind: "authorized_wake",
      triggerId: input.triggerId,
      sourceTurnId: input.sourceTurnId,
      authorizationRef: input.authorizationRef,
      ...(input.resultScopeRef ? { resultScopeRef: input.resultScopeRef } : {}),
    },
    route: {
      role: "butler",
      workspacePath: process.cwd(),
      reason: "app-worker-result",
    },
  };
}
