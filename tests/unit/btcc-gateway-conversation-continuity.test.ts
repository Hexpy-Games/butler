import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBtcc } from
  "../../packages/butler-agent/src/agent/btcc/btcc.ts";
import type {
  BtccRunCommand,
  BtccTurnProgressObserver,
} from "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import type { BtccTurnOutcome } from
  "../../packages/butler-agent/src/agent/btcc/index.ts";
import { DefaultBtccTurnPreparation } from
  "../../packages/butler-agent/src/agent/btcc/turn/prepare-turn.ts";
import {
  AgentConversationStore,
  conversationMessagesSourceHash,
} from
  "../../packages/butler-agent/src/agent/conversation/store.ts";
import type { ContextAssembly } from
  "../../packages/butler-agent/src/agent/prompt/prompt-assembler.ts";
import { PromptAssembler } from
  "../../packages/butler-agent/src/agent/prompt/prompt-assembler.ts";
import { includeRecentContext } from
  "../../packages/butler-agent/src/agent/btcc/turn/recent-conversation-context.ts";
import type { GatewayRoute, InboundEnvelope } from
  "../../packages/butler-agent/src/gateways/core/contracts.ts";
import { createBtccGatewayHandlers } from
  "../../packages/butler-agent/src/interfaces/gateway/btcc/create-btcc-gateway-handlers.ts";
import { SessionBindingStore } from
  "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import {
  InMemoryBtccProgressEventRepository,
  InMemoryBtccWakeAuthorizationRepository,
  ScriptedBtccGatewayRuntime,
} from "./support/fake-btcc-gateway-runtime.ts";
import type { TurnRecord } from
  "../../packages/butler-agent/src/agent/btcc/turn/contracts.ts";
import { createAppCancellationEnvelope, createAppResumeEnvelope } from
  "../../packages/butler-agent/src/gateways/core/app-transport.ts";
import type { Btcc } from
  "../../packages/butler-agent/src/agent/btcc/contracts.ts";
import type { SubsessionDelegationService } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/index.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("typed cancellation invokes only BTCC stop and returns a durable ack", async () => {
  const stopped: string[] = [];
  const btcc: Btcc = {
    runTurn: async () => {
      throw new Error("cancellation must not enter runTurn");
    },
    stopTurn: async ({ turnId }) => {
      stopped.push(turnId);
      return { kind: "cancelled", turnId };
    },
  };
  const result = await createBtccGatewayHandlers({ btcc }).butler!({
    route: {
      sessionId: "butler/app-cancel",
      role: "butler",
      reason: "session-hint",
      workspacePath: process.cwd(),
    },
    envelope: createAppCancellationEnvelope({
      chatId: "app-cancel",
      sessionId: "butler/app-cancel",
      turnId: "turn-cancel",
      requestId: "cancel-request",
      requestedAt: "2026-08-13T00:00:00.000Z",
    }),
  });

  expect(stopped).toEqual(["turn-cancel"]);
  expect(result.metadata).toMatchObject({
    text: "",
    turnId: "turn-cancel",
    controlAck: {
      kind: "cancel_turn",
      requestId: "cancel-request",
      turnId: "turn-cancel",
      outcome: "cancelled",
    },
  });
});

test("cancelling an already delivered Turn completes the control request", async () => {
  const btcc: Btcc = {
    runTurn: async () => {
      throw new Error("cancellation must not enter runTurn");
    },
    stopTurn: async ({ turnId }) => ({
      kind: "already_delivered",
      turnId,
      messageId: "assistant-delivered",
      content: "already complete",
    }),
  };

  const result = await createBtccGatewayHandlers({ btcc }).butler!({
    route: {
      sessionId: "butler/app-cancel-delivered",
      role: "butler",
      reason: "session-hint",
      workspacePath: process.cwd(),
    },
    envelope: createAppCancellationEnvelope({
      chatId: "app-cancel-delivered",
      sessionId: "butler/app-cancel-delivered",
      turnId: "turn-already-delivered",
      requestId: "cancel-delivered-request",
      requestedAt: "2026-09-01T00:00:00.000Z",
    }),
  });

  expect(result.metadata).toMatchObject({
    text: "",
    kind: "turn_cancellation_noop",
    turnId: "turn-already-delivered",
    controlAck: {
      kind: "cancel_turn",
      requestId: "cancel-delivered-request",
      turnId: "turn-already-delivered",
      outcome: "already_delivered",
    },
  });
});

test("typed resume re-enters the exact admitted BTCC request identity", async () => {
  const requests: Parameters<Btcc["runTurn"]>[0][] = [];
  const btcc: Btcc = {
    runTurn: async (request) => {
      requests.push(request);
      return {
        kind: "delivered",
        turnId: request.turnId,
        messageId: "assistant-resumed",
        content: "resumed",
      };
    },
    stopTurn: async ({ turnId }) => ({ kind: "already_cancelled", turnId }),
  };
  const result = await createBtccGatewayHandlers({ btcc }).steward!({
    route: {
      sessionId: "steward/resume",
      role: "steward",
      reason: "steward-hint",
      workspacePath: process.cwd(),
    },
    envelope: createAppResumeEnvelope({
      chatId: "steward/resume",
      sessionId: "steward/resume",
      turnId: "turn-resume",
      requestId: "resume-request",
      requestedAt: "2026-08-22T00:00:00.000Z",
      originalEventId: "app:steward-original",
      originalMessageId: "steward-message:original",
      originalMessage: "original private delegated input",
    }),
  });

  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    turnId: "turn-resume",
    eventId: "app:steward-original",
    sessionId: "steward/resume",
    message: {
      id: "steward-message:original",
      content: "original private delegated input",
    },
  });
  expect(result.handledBy).toBe("btcc/turn-resume");
});

test("Steward delivery without completed Work is reported as failed", async () => {
  const completed: Array<{ status?: string; summary?: string }> = [];
  const subsessionDelegation = {
    activeParentDelegations: async () => [],
    completeStewardResult: async (input: { status?: string; summary?: string }) => {
      completed.push(input);
      return undefined as never;
    },
  } as unknown as SubsessionDelegationService;
  const handlers = createBtccGatewayHandlers({
    btcc: {
      runTurn: async () => ({
        kind: "delivered",
        turnId: "steward-turn-failed",
        messageId: "steward-message-failed",
        content: "내부 실행 오류로 작업을 완료하지 못했습니다.",
      }),
      stopTurn: async ({ turnId }) => ({ kind: "cancelled", turnId }),
    },
    subsessionDelegation,
  });

  await handlers.steward!({
    route: {
      sessionId: "steward/failed",
      role: "steward",
      reason: "steward-hint",
      workspacePath: process.cwd(),
    },
    envelope: envelope(
      "steward-turn-failed",
      "steward-input-failed",
      "위임 작업을 완료해 주세요.",
    ),
  });

  expect(completed).toHaveLength(1);
  expect(completed[0]).toMatchObject({
    status: "failed",
    summary: "내부 실행 오류로 작업을 완료하지 못했습니다.",
  });
});

test("Worker without a completed Micro Work is reported to its Steward as blocked", async () => {
  const completed: Array<
    Parameters<SubsessionDelegationService["completeWorkerResult"]>[0]
  > = [];
  const handlers = createBtccGatewayHandlers({
    btcc: {
      runTurn: async () => ({
        kind: "delivered",
        turnId: "worker-turn-blocked",
        messageId: "worker-message-blocked",
        content: "Worker repeated the same non-progress pattern without changing workspace output.",
        workStatus: "blocked",
      }),
      stopTurn: async ({ turnId }) => ({ kind: "cancelled", turnId }),
    },
    subsessionDelegation: {
      completeWorkerResult: async (
        input: Parameters<SubsessionDelegationService["completeWorkerResult"]>[0],
      ) => {
        completed.push(input);
        return undefined as never;
      },
    } as unknown as SubsessionDelegationService,
  });

  await handlers.worker!({
    route: {
      sessionId: "worker/blocked",
      role: "worker",
      reason: "session-hint",
      workspacePath: process.cwd(),
    },
    envelope: envelope(
      "worker-turn-blocked",
      "worker-input-blocked",
      "Execute the assigned Plan action.",
    ),
  });

  expect(completed).toEqual([{
    childSessionId: "worker/blocked",
    childTurnId: "worker-turn-blocked",
    resultId: expect.any(String),
    summary: "Worker repeated the same non-progress pattern without changing workspace output.",
    status: "blocked",
    code: "worker_work_incomplete",
    changedArtifacts: [],
    changedFiles: [],
  }]);
});

test("Worker terminal findings reach its Steward without truncation", async () => {
  const completed: Array<
    Parameters<SubsessionDelegationService["completeWorkerResult"]>[0]
  > = [];
  const actionableTail = "REVIEW_TAIL: restore the missing regression test before completion.";
  const report = ["Worker review", "x".repeat(9_000), actionableTail].join("\n");
  const handlers = createBtccGatewayHandlers({
    btcc: {
      runTurn: async () => ({
        kind: "delivered",
        turnId: "worker-turn-full-report",
        messageId: "worker-message-full-report",
        content: report,
        workStatus: "completed",
      }),
      stopTurn: async ({ turnId }) => ({ kind: "cancelled", turnId }),
    },
    subsessionDelegation: {
      completeWorkerResult: async (
        input: Parameters<SubsessionDelegationService["completeWorkerResult"]>[0],
      ) => {
        completed.push(input);
        return undefined as never;
      },
    } as unknown as SubsessionDelegationService,
  });

  await handlers.worker!({
    route: {
      sessionId: "worker/full-report",
      role: "worker",
      reason: "session-hint",
      workspacePath: process.cwd(),
    },
    envelope: envelope(
      "worker-turn-full-report",
      "worker-input-full-report",
      "Review the implementation and report every finding.",
    ),
  });

  expect(completed).toHaveLength(1);
  expect(completed[0]?.summary).toBe(report);
  expect(completed[0]?.summary).toEndWith(actionableTail);
});

test("Steward delivery preserves its complete factual report for Butler synthesis", async () => {
  const completed: Array<{ status?: string; summary?: string }> = [];
  const report = [
    "Sandy P0 telemetry 작업을 완료했습니다.",
    "",
    "- 검증: npm test, quality:check",
    "- 커밋: 4e8cc7d, 568e046",
    "- 남은 위험: 없음",
  ].join("\n");
  const handlers = createBtccGatewayHandlers({
    btcc: {
      runTurn: async () => ({
        kind: "delivered",
        turnId: "steward-turn-report",
        messageId: "steward-message-report",
        content: report,
        workStatus: "completed",
      }),
      stopTurn: async ({ turnId }) => ({ kind: "cancelled", turnId }),
    },
    subsessionDelegation: {
      activeParentDelegations: async () => [],
      completeStewardResult: async (input: { status?: string; summary?: string }) => {
        completed.push(input);
        return undefined as never;
      },
    } as unknown as SubsessionDelegationService,
  });

  await handlers.steward!({
    route: {
      sessionId: "steward/report",
      role: "steward",
      reason: "steward-hint",
      workspacePath: process.cwd(),
    },
    envelope: envelope("steward-turn-report", "steward-input-report", "작업을 완료해 주세요."),
  });

  expect(completed).toHaveLength(1);
  expect(completed[0]).toMatchObject({ status: "success", summary: report });
});

test("BTCC facade commits each Turn and gives the next Turn recent conversation", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "btcc-facade-conversation-"));
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
  const promptMaterialInputs: Array<{ tailLimit?: number }> = [];
  const readPromptMaterial = conversationStore.readPromptMaterial.bind(conversationStore);
  conversationStore.readPromptMaterial = (input) => {
    promptMaterialInputs.push(input);
    return readPromptMaterial(input);
  };
  const runtime = new ScriptedBtccGatewayRuntime((command) =>
    command.kind === "run" && command.turnId === "turn-1"
      ? "첫 번째 점검 결과"
      : "이어서 완료했습니다",
  );
  const { btcc, host } = createBtcc({
    runtime: runtime.runtime,
    preparation: new DefaultBtccTurnPreparation({
      bindingStore,
      conversationStore,
      butlerData,
      promptAssembler: new PromptAssembler({
        butlerHome: process.cwd(),
        butlerData,
      }),
      contextDocuments: runtime.contextDocuments,
      turns: { findTurn: async () => null },
      wakeAuthorizations: runtime.wakeAuthorizations,
    }),
    progressEvents: runtime.progressEvents,
    turns: { findTurn: async () => null },
  });
  const route: GatewayRoute = {
    sessionId: binding.sessionId,
    role: "butler",
    reason: "session-hint",
    workspacePath: binding.workspacePath,
  };
  const handlers = createBtccGatewayHandlers({ btcc });

  try {
    await handlers.butler!({ envelope: envelope("turn-1", "message-1", "정적 import 경로를 점검해 주세요."), route });
    await handlers.butler!({ envelope: envelope("turn-2", "message-2", "방금 점검을 이어서 진행해 주세요."), route });

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
    expect(promptMaterialInputs).toHaveLength(1);
    expect(promptMaterialInputs[0]?.tailLimit).toBeDefined();
    expect(promptMaterialInputs[0]?.tailLimit).toBeGreaterThan(0);
    expect(promptMaterialInputs[0]?.tailLimit).toBeLessThanOrEqual(200);

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
    await host.close();
    conversationStore.close();
    bindingStore.close();
  }
});

test("BTCC facade keeps delivery when optional title generation fails", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "btcc-facade-title-failure-"));
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
  const runtime = new ScriptedBtccGatewayRuntime("요청을 처리했습니다.");
  const { btcc, host } = createBtcc({
    runtime: runtime.runtime,
    preparation: new DefaultBtccTurnPreparation({
      bindingStore,
      conversationStore,
      butlerData,
      promptAssembler: new PromptAssembler({ butlerHome: process.cwd(), butlerData }),
      contextDocuments: runtime.contextDocuments,
      turns: { findTurn: async () => null },
      wakeAuthorizations: runtime.wakeAuthorizations,
    }),
    progressEvents: runtime.progressEvents,
    turns: { findTurn: async () => null },
  });
  const route: GatewayRoute = {
    sessionId: binding.sessionId,
    role: "butler",
    reason: "session-hint",
    workspacePath: binding.workspacePath,
  };
  try {
    const handlers = createBtccGatewayHandlers({
      btcc,
      generateSessionTitle: async () => {
        throw new Error("provider rate limited optional title generation");
      },
    });
    const result = await handlers.butler!({
      envelope: envelope("turn-title-failure", "message-title-failure", "페이지를 만들어 주세요."),
      route,
    });
    expect(result.metadata?.text).toBe("요청을 처리했습니다.");
    expect(result.metadata?.generatedSessionTitle).toBeNull();
    expect(conversationStore.readTurn("turn-title-failure")?.status).toBe("complete");
  } finally {
    await host.close();
    conversationStore.close();
    bindingStore.close();
  }
});

test("BTCC gateway handler exposes committed artifacts to outbound projection", async () => {
  const handlers = createBtccGatewayHandlers({
    btcc: {
      async runTurn() {
        return {
          kind: "delivered",
          turnId: "turn-artifact-gateway",
          messageId: "message-artifact-gateway",
          content: "캡처 결과입니다.",
          artifacts: [{
            id: "artifact-page",
            kind: "chart_file",
            title: "page.png",
            safePathLabel: "artifacts/generated/capture/page.png",
            mimeType: "image/png",
            sizeBytes: 128,
          }],
        } as const;
      },
      async stopTurn(request) {
        return { kind: "cancelled", turnId: request.turnId } as const;
      },
    },
  });
  const route: GatewayRoute = {
    sessionId: "butler/app-chat-artifacts",
    role: "butler",
    reason: "session-hint",
    workspacePath: process.cwd(),
  };

  const result = await handlers.butler!({
    envelope: envelope(
      "turn-artifact-gateway",
      "message-artifact-gateway",
      "캡처를 첨부해 주세요.",
    ),
    route,
  });

  expect(result.metadata?.artifacts).toEqual([{
    id: "artifact-page",
    kind: "chart_file",
    title: "page.png",
    safePathLabel: "artifacts/generated/capture/page.png",
    mimeType: "image/png",
    sizeBytes: 128,
  }]);
});

test("recent context admission bounds large canonical history while retaining summary and latest context", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "btcc-bounded-recent-context-"));
  roots.push(butlerData);
  const bindingStore = new SessionBindingStore(
    join(butlerData, "runtime", "session-store.sqlite"),
  );
  const binding = bindingStore.upsert({
    sessionId: "butler/app-bounded-recent-context",
    role: "butler",
    workspacePath: butlerData,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.6-sol",
    transportBindings: [],
  });
  const conversationStore = new AgentConversationStore({ butlerData });
  const turn = conversationStore.beginTurn({
    gateway: "app",
    externalSessionId: binding.sessionId,
    sessionId: binding.sessionId,
    actor: "user",
    turnId: "turn-bounded-history",
  });
  const first = conversationStore.appendAssistantMessage({
    sessionId: binding.sessionId,
    turnId: turn.id,
    text: "history-0",
  });
  conversationStore.writeSummary({
    sessionId: binding.sessionId,
    coversFromSeq: first.seq,
    coversToSeq: first.seq,
    sourceHash: conversationMessagesSourceHash([first]),
    summaryText: "historical decision must remain available",
  });
  for (let index = 1; index < 1_200; index += 1) {
    conversationStore.appendAssistantMessage({
      sessionId: binding.sessionId,
      turnId: turn.id,
      text: `history-${index}`,
    });
  }

  const promptMaterialInputs: Array<{ tailLimit?: number }> = [];
  const readPromptMaterial = conversationStore.readPromptMaterial.bind(conversationStore);
  conversationStore.readPromptMaterial = (input) => {
    promptMaterialInputs.push(input);
    const material = readPromptMaterial(input);
    expect(material.semantic_tail.length).toBeLessThanOrEqual(input.tailLimit ?? 0);
    return material;
  };
  const emptyAssembly: ContextAssembly = {
    staticContext: [],
    liveConfiguration: [],
    runtimeState: [],
    workingContext: [],
    retrievedContext: [],
    currentInput: [],
    references: [],
    liveConfigHash: "bounded-history-test",
  };

  try {
    const assembly = includeRecentContext(
      conversationStore,
      binding,
      {
        eventId: "event-bounded-history",
        transport: "app",
        accountId: "local",
        peer: { kind: "dm", id: binding.sessionId },
        sender: { id: "local-principal" },
        message: {
          id: "message-bounded-history",
          text: "continue",
          timestamp: "2026-07-28T00:00:00.000Z",
        },
      },
      emptyAssembly,
    );
    const recent = assembly.workingContext[0]?.content ?? "";
    expect(promptMaterialInputs).toHaveLength(1);
    expect(promptMaterialInputs[0]?.tailLimit).toBeDefined();
    expect(promptMaterialInputs[0]?.tailLimit).toBeLessThan(1_200);
    expect(recent).toContain("historical decision must remain available");
    expect(recent).toContain("history-1199");
    expect(recent).not.toContain("history-0");
  } finally {
    conversationStore.close();
    bindingStore.close();
  }
});

test("a replay uses the same typed user request and never injects a resume marker", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "btcc-facade-replay-"));
  roots.push(butlerData);
  const bindingStore = new SessionBindingStore(
    join(butlerData, "runtime", "session-store.sqlite"),
  );
  const binding = bindingStore.upsert({
    sessionId: "butler/app-chat-replay",
    role: "butler",
    workspacePath: process.cwd(),
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.6-sol",
    transportBindings: [],
  });
  const conversationStore = new AgentConversationStore({ butlerData });
  const runtime = new ScriptedBtccGatewayRuntime("저장된 최종 답변");
  const { btcc, host } = createBtcc({
    runtime: runtime.runtime,
    preparation: new DefaultBtccTurnPreparation({
      bindingStore,
      conversationStore,
      butlerData,
      promptAssembler: new PromptAssembler({ butlerHome: process.cwd(), butlerData }),
      contextDocuments: runtime.contextDocuments,
      turns: { findTurn: async () => null },
      wakeAuthorizations: runtime.wakeAuthorizations,
    }),
    progressEvents: runtime.progressEvents,
    turns: { findTurn: async () => null },
  });
  const handlers = createBtccGatewayHandlers({ btcc });
  const route: GatewayRoute = {
    sessionId: binding.sessionId,
    role: "butler",
    reason: "session-hint",
    workspacePath: binding.workspacePath,
  };
  try {
    const input = envelope("turn-replay", "message-replay", "이전 답변을 복구해 주세요.");
    await handlers.butler!({ envelope: input, route });
    await handlers.butler!({ envelope: input, route });
    expect(runtime.commands.every((command) => command.kind === "run")).toBe(true);
    expect(input.raw).toBeUndefined();
  } finally {
    await host.close();
    conversationStore.close();
    bindingStore.close();
  }
});

test("a durable replay resumes frozen facts despite current binding and conversation changes", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "btcc-frozen-replay-"));
  roots.push(butlerData);
  const bindingStore = new SessionBindingStore(
    join(butlerData, "runtime", "session-store.sqlite"),
  );
  const binding = bindingStore.upsert({
    sessionId: "butler/frozen-replay",
    role: "butler",
    workspacePath: process.cwd(),
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.6-sol",
    transportBindings: [],
    metadata: { accessMode: "full_access", reasoning_effort: "high" },
  });
  const conversationStore = new AgentConversationStore({ butlerData });
  const runtime = new FrozenReplayRuntime();
  let storedTurn: TurnRecord | null = null;
  const contextDocuments = {
    persist(input: { scopeKind: string; scopeId: string; sourceId: string; content: string }) {
      runtime.persistedDocuments.push(input);
      return `context:${input.scopeKind}:${input.scopeId}:${input.sourceId}`;
    },
  };
  const { btcc, host } = createBtcc({
    runtime,
    preparation: new DefaultBtccTurnPreparation({
      bindingStore,
      conversationStore,
      butlerData,
      promptAssembler: new PromptAssembler({ butlerHome: process.cwd(), butlerData }),
      contextDocuments,
      turns: { findTurn: async () => storedTurn },
      wakeAuthorizations: runtime.wakeAuthorizations,
    }),
    progressEvents: runtime.progressEvents,
    turns: { findTurn: async () => storedTurn },
  });
  const route: GatewayRoute = {
    sessionId: binding.sessionId,
    role: "butler",
    reason: "session-hint",
    workspacePath: binding.workspacePath,
  };
  const handlers = createBtccGatewayHandlers({ btcc });
  const input = envelope("turn-frozen", "message-frozen", "고정된 요청을 복구해 주세요.");

  try {
    await handlers.butler!({ envelope: input, route });
    storedTurn = runtime.admittedTurn;
    expect(storedTurn).not.toBeNull();
    const documentCountAfterAdmission = runtime.persistedDocuments.length;

    const session = conversationStore.getSessionByGatewayBinding("app", binding.sessionId);
    if (!session) throw new Error("conversation session missing");
    conversationStore.beginTurn({
      gateway: "app",
      externalSessionId: binding.sessionId,
      sessionId: session.id,
      actor: "user",
      turnId: "unrelated-turn",
      requestId: "unrelated-event",
      now: "2026-08-03T00:01:00.000Z",
    });
    conversationStore.appendUserMessage({
      sessionId: session.id,
      turnId: "unrelated-turn",
      text: "현재 최근 대화는 이제 달라졌습니다.",
      sourceGateway: "app",
      sourceRef: "unrelated-message",
    });
    bindingStore.upsert({
      sessionId: binding.sessionId,
      role: "butler",
      workspacePath: "/changed/workspace",
      runtimeAdapterId: "btcc-turn-runtime",
      modelProviderId: "other-provider",
      modelRef: "other-provider/other-model",
      transportBindings: [],
      metadata: { accessMode: "read_only", reasoning_effort: "none" },
    });

    const replay = await handlers.butler!({
      envelope: createAppResumeEnvelope({
        chatId: binding.sessionId,
        sessionId: binding.sessionId,
        turnId: "turn-frozen",
        requestId: "resume-frozen",
        requestedAt: "2026-08-03T00:02:00.000Z",
        originalEventId: input.eventId,
        originalMessageId: input.message.id,
        originalMessage: input.message.text!,
      }),
      route,
    });
    expect(replay.metadata?.text).toBe("stored answer");
    expect(runtime.commands.map((command) => command.kind)).toEqual(["run", "resume"]);
    expect(runtime.modelCalls).toBe(1);
    expect(runtime.persistedDocuments).toHaveLength(documentCountAfterAdmission);

    await expect(handlers.butler!({
      envelope: { ...input, eventId: "event-message-frozen-mismatch" },
      route,
    })).rejects.toThrow("does not match admitted Turn");
    expect(runtime.modelCalls).toBe(1);
  } finally {
    await host.close();
    conversationStore.close();
    bindingStore.close();
  }
});

class FrozenReplayRuntime {
  readonly commands: BtccRunCommand[] = [];
  readonly persistedDocuments: Array<Record<string, string>> = [];
  readonly progressEvents = new InMemoryBtccProgressEventRepository();
  readonly wakeAuthorizations = new InMemoryBtccWakeAuthorizationRepository();
  readonly admittedTurn: TurnRecord = {
    turnId: "turn-frozen",
    sessionId: "butler/frozen-replay",
    inboxId: "inbox-frozen",
    triggerKey: "event-message-frozen",
    originalMessageId: "message-frozen",
    originalMessage: "고정된 요청을 복구해 주세요.",
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      controls: { accessMode: "full_access" },
      controlsHash: "frozen-controls",
    },
    context: {
      userRef: "local-principal",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [],
      executionPolicy: {
        role: "butler",
        accessMode: "full_access",
        trackingMode: "local",
        requiredNativeToolProfiles: [],
        requiredNativeTools: [],
        workspacePath: "/frozen/workspace",
      },
    },
    semanticState: "delivered",
    revision: 3,
    executionFence: 1,
    finalDisposition: "completed",
  };
  modelCalls = 0;

  async runTurn(
    command: BtccRunCommand,
    progress?: BtccTurnProgressObserver,
    onAdmitted?: (isFresh: boolean) => void | Promise<void>,
  ): Promise<BtccTurnOutcome> {
    this.commands.push(command);
    await onAdmitted?.(command.kind !== "resume");
    if (command.kind === "run") {
      this.modelCalls += 1;
      await progress?.stateChanged({
        turnId: command.turnId,
        semanticState: "delivery_committed",
        turnRevision: 2,
      });
      await progress?.stateChanged({
        turnId: command.turnId,
        semanticState: "delivered",
        turnRevision: 3,
      });
      return {
        kind: "delivered",
        turnId: command.turnId,
        messageId: "assistant:frozen",
        content: "first answer",
      };
    }
    return {
      kind: "already_delivered",
      turnId: command.turnId,
      messageId: "assistant:frozen",
      content: "stored answer",
    };
  }

  async stopTurn(command: { kind: "stop"; turnId: string }): Promise<BtccTurnOutcome> {
    return { kind: "cancelled", turnId: command.turnId };
  }
}

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
