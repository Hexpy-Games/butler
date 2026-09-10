#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { createConnection, createServer } from "node:net";
import { digest as btccDigest, stableJson as btccStableJson } from
  "../../packages/butler-agent/src/agent/btcc/identity/index.ts";
import type {
  ModelRoundPort,
  ModelRoundRequest,
  ModelRoundResult,
} from "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import type {
  BtccInboundDispatcher,
  BtccInboundDispatchOptions,
} from "../../packages/butler-agent/src/interfaces/gateway/btcc/index.ts";
import { subsessionResultClientMessageId } from
  "../../packages/butler-agent/src/gateways/app/interface/protocol/internal-result-contract.ts";
import { createLazyConversationProjectionReader } from
  "../../packages/butler-agent/src/agent/conversation/projection-reader-store.ts";
import { toContextMessage } from
  "../../packages/butler-agent/src/agent/context/conversation-context-format.ts";
import { decodeMessageScalars } from
  "../../packages/butler-agent/src/agent/cognition/memory/projection/source.ts";
import type {
  MemoryOwnerResultEvidence,
  MemoryPerformanceMetricsEvidence,
  MemoryQueryResultEvidence,
  MemoryQueueWorkEvidence,
  MemoryRecoveryAcceptance,
  MemoryRecoveryCaseTrace,
  MemoryRecoveryPerformanceReport,
  MemorySourceBindingEvidence,
  MemorySourceReadEvidence,
} from "../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts";

const S1 = "내 고양이 루나의 영어 이름은 Luna야.";
const S2 = "Luna likes the blue ball.";
const S3 = "訂正するね。Lunaは青いボールが好きではなく、赤いボールが好きです。";
const S3_QUERY = "ما اللعبة التي تحبها قطتي الآن؟";
const T4_ARABIC_Q = "ما اللعبة التي تحبها قطتي؟";
const FIXED_B_CUE = "내 고양이가 좋아하는 장난감은 무엇인가요?";
const T4_PERFORMANCE_QUERY_BINDING_SHA = "78356b1adb58f24ad182210a699f33aacb571395893fe8300f2dc170f7b8dd7f";
const T4_PERFORMANCE_SOURCE_BINDING_SHA = "a622c91f499c57b82d937ae3573d3797100e9f92989b61583a185135d72d2f95";
const T4_SUPPLEMENTARY_INPUTS = [
  { text: "오늘 저녁에는 집 근처 공원을 산책했어요. 연못 가장자리에서 흰 새 두 마리를 봤어요.", sha256: "2e15c60f612ab21a87433875aba67def337f1bdd31ba673d7dbae9864b7c6e39" },
  { text: "아침에 작은 빵집에서 호밀빵을 샀어요. 따뜻한 차와 함께 먹으니 좋았어요.", sha256: "3217eb14a56e1071957a43ebef44e706b55d889d68c4006b63fb652ac9dd4366" },
  { text: "주말에 책장을 정리하다가 오래된 여행 수첩을 찾았어요. 다음에는 사진도 정리하려고 해요.", sha256: "9a1c74f5ad9494fca7edc2fc937c0545e836a033cdcb65ad1974b30268ac9890" },
  { text: "퇴근 후에 창가의 화분에 물을 줬어요. 바질에서 새잎이 나고 있었어요.", sha256: "b0519a416489b4f2d1c804f98ebe1e512a7b38efad752ff513efd1cbb1de3ddf" },
] as const;
const T4_CLI_DELTA = "격리된 전환 검증용 대화입니다. 오늘은 창문을 열고 아침 공기를 확인했어요.";

type T4PerformanceOptions = {
  queryBindingPath: string;
  artifactDir: string;
  supplementMaxLogicalRounds: number;
  supplementMaxDispatches: number;
  projectionMaxPollCalls: number;
  performanceMaxWallClockMs: number;
};

type LiveRecoveryMode =
  | { kind: "accepted_pending" }
  | {
      kind: "t4_actual_phase";
      baselinePath: string;
      maxPollCalls: number;
      maxIngressPollCalls: number;
      maxWallClockMs: number;
      performance?: T4PerformanceOptions;
      resumeAfterQ1ReviewPath?: string;
    }
  | {
      kind: "preserved_failed_third";
      baselinePath: string;
      maxPollCalls: number;
      maxWallClockMs: number;
    }
  | {
      kind: "preserved_complete_three_pending_b1" | "preserved_complete_three_failed_b1" | "preserved_completed_b_corpus" | "preserved_failed_s3";
      baselinePath: string;
      maxPollCalls: number;
      maxIngressPollCalls: number;
      maxWallClockMs: number;
    };
type LivePollBudget = { calls: number; maxCalls: number; deadlineAt: number; maxExtraLeaves?: number };
type IngressPollBudget = {
  calls: number;
  maxCalls: number;
  deadlineAt: number;
};
type AppTarget = {
  chatId: string;
  messageId: string | null;
  turnId: string | null;
  queueId: string | null;
  clientMessageId: string | null;
  requestText: string;
  admittedText: string;
  requestBytes: number;
  requestSha256: string;
  admittedBytes: number;
  admittedSha256: string;
};
type DeliveredTarget = AppTarget & {
  messageId: string;
  turnId: string;
  conversationSessionId: string;
  conversationTurnId: string;
  conversationRequestMessageId: string;
  conversationAssistantMessageId: string;
  assistantText: string;
  lastDispatch: {
    claimed: number;
    handled: number;
    failed: number;
    interrupted: number;
  };
  unrelatedHandled: number;
  originalDelivery?: DeliveredTarget;
  delegatedTerminalStatus?: "success" | "blocked" | "failed" | "cancelled";
};

export async function runMemoryRecoveryDispatcherHarness(dataRoot: string, options?: {
  afterReady?: (control: { dispatch(text: string): Promise<DeliveredTarget> }) => Promise<unknown>;
}) {
  const butlerData = resolve(dataRoot);
  if (!dataRoot.trim()) throw new Error("--data-root is required");
  if (existsSync(butlerData)) {
    throw new Error(
      "dispatcher harness requires a fresh nonexistent data root",
    );
  }
  process.env.BUTLER_DATA = butlerData;
  mkdirSync(butlerData, { recursive: true, mode: 0o700 });

  const [
    { createProductionBtccComposition },
    { BtccInboundDispatcher, createBtccGatewayHandlers },
    { createAppTransportAdapter },
    { DeliveryGuard },
    { createGatewayServer },
    { GatewayRouter },
    { NativeInboundQueue },
    { createAppServer },
    { SessionBindingStore },
    { AgentConversationStore },
    { initializeEmptyMemoryGeneration },
  ] = await Promise.all([
    import("../../packages/butler-agent/src/agent/composition/index.ts"),
    import("../../packages/butler-agent/src/interfaces/gateway/btcc/index.ts"),
    import("../../packages/butler-agent/src/interfaces/transport/app/adapter.ts"),
    import("../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts"),
    import("../../packages/butler-agent/src/gateways/core/server.ts"),
    import("../../packages/butler-agent/src/gateways/core/router.ts"),
    import("../../packages/butler-agent/src/gateways/core/inbound-queue.ts"),
    import("../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts"),
    import("../../packages/butler-agent/src/test-support/harness/session-store.ts"),
    import("../../packages/butler-agent/src/agent/conversation/store.ts"),
    import("../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts"),
  ]);
  markExecutorReady(butlerData);
  const descriptor = initializeEmptyMemoryGeneration(butlerData);
  let modelCalls = 0;
  let activeTargetTurnId: string | null = null;
  let dispatcherModelError: Error | null = null;
  let oldTurnId: string | null = null;
  let unrelatedModelCalls = 0;
  let expectedCanonicalSessionId: string | null = null;
  let expectedRuntimeSessionId: string | null = null;
  const memoryToolTrace: {
    recall?: any;
    query?: any;
    list?: any;
    readArgs?: any;
    read?: any;
    missingBinding?: any;
  } = {};
  const oldGate: { release?: () => void } = {};
  let signalOldCanonicalReady: (() => void) | null = null;
  const oldCanonicalReady = new Promise<void>((resolve) => {
    signalOldCanonicalReady = resolve;
  });
  const bindings = new SessionBindingStore(
    `${butlerData}/runtime/session-store.sqlite`,
    "ephemeral",
  );
  let app = createAppServer({
    dbPath: `${butlerData}/app.sqlite`,
    butlerData,
    butlerHome: process.cwd(),
    port: 0,
    automationSchedulerIntervalMs: false,
  });
  const modelRound: ModelRoundPort = {
    async runRound(request) {
      const actualTurnId = request.usageAttribution?.turnId ?? null;
      if (actualTurnId === oldTurnId) {
        unrelatedModelCalls += 1;
        return final("선행 정상 App 응답입니다.");
      }
      if (!activeTargetTurnId || actualTurnId !== activeTargetTurnId) {
        dispatcherModelError = new Error(
          `dispatcher model target mismatch: ${JSON.stringify({ expected: activeTargetTurnId, actual: actualTurnId })}`,
        );
        throw dispatcherModelError;
      }
      modelCalls += 1;
      if (modelCalls === 1) return final("합성 dispatcher 확인 응답입니다.");
      if (modelCalls === 2) {
        return tools([
          {
            id: "dispatcher-recall",
            name: "recall_memory",
            args: {
              cue: S2,
              scope: "all_user_sessions",
              project_filter: "unassigned",
              include_internal: false,
              include_vector: false,
              time: {
                from: "2000-01-01T00:00:00.000Z",
                to: "2100-01-01T00:00:00.000Z",
                basis: "conversation",
              },
              limit: 6,
            },
          },
          {
            id: "dispatcher-query",
            name: "query_memory",
            args: {
              query: S2,
              match_mode: "phrase",
              scope: "all_user_sessions",
              include_internal: false,
              limit: 6,
            },
          },
          {
            id: "dispatcher-list",
            name: "list_conversation_sessions",
            args: {
              scope: "all_user_sessions",
              include_internal: false,
              preview_messages: 1,
              limit: 6,
            },
          },
        ]);
      }
      if (modelCalls === 3) {
        memoryToolTrace.recall = toolOutputById(
          request,
          "dispatcher-recall",
        );
        memoryToolTrace.query = toolOutputById(request, "dispatcher-query");
        memoryToolTrace.list = toolOutputById(request, "dispatcher-list");
        const queried = memoryToolTrace.query.results.find(
          (item: any) => item.excerpt === S2,
        );
        memoryToolTrace.readArgs = queried?.read_args;
        if (!memoryToolTrace.readArgs) {
          throw new Error("dispatcher query did not return canonical read_args");
        }
        if (
          !Array.isArray(memoryToolTrace.recall.results) ||
          memoryToolTrace.recall.coverage?.source?.candidates < 1
        ) {
          throw new Error("dispatcher recall did not read synthetic projection");
        }
        return tool(
          "dispatcher-read",
          "read_conversation_session",
          structuredClone(memoryToolTrace.readArgs),
        );
      }
      if (modelCalls === 4) {
        memoryToolTrace.read = toolOutputById(request, "dispatcher-read");
        const querySessionId = memoryToolTrace.query.results.find(
          (item: any) => item.excerpt === S2,
        )?.conversation_session_id;
        if (
          !expectedCanonicalSessionId || !expectedRuntimeSessionId ||
          expectedCanonicalSessionId === expectedRuntimeSessionId ||
          querySessionId !== expectedCanonicalSessionId ||
          memoryToolTrace.read.conversation_session_id !==
            expectedCanonicalSessionId ||
          memoryToolTrace.list.current_conversation_session_id !==
            expectedCanonicalSessionId ||
          !memoryToolTrace.list.sessions.some((session: any) =>
            session.conversation_session_id === expectedCanonicalSessionId,
          )
        ) {
          throw new Error("memory tools did not share canonical App binding");
        }
        const { createMemoryToolHandlers } = await import(
          "../../packages/butler-agent/src/agent/tools/memory/index.ts",
        );
        memoryToolTrace.missingBinding = await createMemoryToolHandlers({
          butlerHome: process.cwd(),
          butlerData,
          sessionId: "unbound-runtime-session",
          turnId: activeTargetTurnId ?? undefined,
          currentUserMessage: S2,
        }).query_memory({
          name: "query_memory",
          args: { query: S2, scope: "all_user_sessions" },
          rawArguments: JSON.stringify({
            query: S2,
            scope: "all_user_sessions",
          }),
          toolContractVersion: 2,
        });
        if (
          memoryToolTrace.missingBinding?.ok !== false ||
          memoryToolTrace.missingBinding?.code !== "invalid_scope"
        ) throw new Error("missing canonical binding did not fail closed");
        return final("합성 canonical memory 도구를 확인했습니다.");
      }
      if (modelCalls > 4 && options?.afterReady) return final("격리된 CLI lifecycle App 원문을 보존했습니다.");
      throw new Error("unexpected dispatcher model round");
    },
  };
  let composition = createProductionBtccComposition({
    butlerHome: process.cwd(),
    butlerData,
    ownerId: `memory-dispatcher:${process.pid}`,
    modelRound,
    sessionBindings: bindings,
    appServerUrl: app.url,
  });
  let gateway = createGatewayServer({
    router: new GatewayRouter({ store: bindings }),
    handlers: createBtccGatewayHandlers({
      btcc: composition.btcc,
      generateSessionTitle: async ({ envelope }) => {
        const turnId = envelope.routingHints?.turnId?.trim() || envelope.eventId;
        if (turnId !== oldTurnId) return null;
        signalOldCanonicalReady?.();
        await new Promise<void>((resolve) => {
          oldGate.release = resolve;
        });
        return null;
      },
    }),
    butlerData,
  });

  try {
    await composition.ready;
    const queue = new NativeInboundQueue(butlerData);
    const dispatcher = new BtccInboundDispatcher();
    const dependencies = {
      queue,
      server: gateway,
      store: bindings,
      deliveryGuard: new DeliveryGuard({
        adapters: [createAppTransportAdapter()],
        butlerData,
      }),
    };
    const oldClientMessageId = `client-${crypto.randomUUID()}`;
    const oldTarget = await admitAppTarget(app.url, S1, oldClientMessageId);
    if (!oldTarget.turnId || oldTarget.queueId)
      throw new Error("normal old App turn was not admitted directly");
    oldTurnId = oldTarget.turnId;
    const secondText = `${S2}\n`;
    const queuedTarget = await admitAppTarget(app.url, secondText);
    if (!queuedTarget.queueId || queuedTarget.messageId || queuedTarget.turnId)
      throw new Error("target was not queued behind the normal old App turn");
    const firstPoll = dispatcher.poll({ ...dependencies, limit: 1 });
    if (firstPoll.claimed !== 1)
      throw new Error("normal old App target was not claimed");
    await oldCanonicalReady;
    const { ConversationProjectionReaderStore } = await import(
      "../../packages/butler-agent/src/agent/conversation/projection-reader-store.ts",
    );
    const oldCanonical = new ConversationProjectionReaderStore(
      `${butlerData}/runtime/conversation-store.sqlite`,
    );
    try {
      const oldTurn = oldCanonical.readTurn(oldTurnId);
      const oldOutcome = oldCanonical.readTurnOutcome(oldTurnId);
      if (
        oldTurn?.status !== "complete" ||
        oldOutcome?.outcome !== "delivered" ||
        oldOutcome.turn_id !== oldTurnId
      )
        throw new Error("old App turn was not canonically complete before recovery");
    } finally {
      oldCanonical.close();
    }
    app.stop();
    app = createAppServer({
      dbPath: `${butlerData}/app.sqlite`,
      butlerData,
      butlerHome: process.cwd(),
      port: 0,
      automationSchedulerIntervalMs: false,
    });
    oldGate.release?.();
    await dispatcher.waitForIdle();
    await composition.host.close();
    composition = createProductionBtccComposition({
      butlerHome: process.cwd(),
      butlerData,
      ownerId: `memory-dispatcher:${process.pid}`,
      modelRound,
      sessionBindings: bindings,
      appServerUrl: app.url,
    });
    await composition.ready;
    gateway = createGatewayServer({
      router: new GatewayRouter({ store: bindings }),
      handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
      butlerData,
    });
    dependencies.server = gateway;
    const second = await sendAndDispatch(
      app.url,
      secondText,
      dispatcher,
      dependencies,
      undefined,
      {
        butlerData,
        resume: queuedTarget,
        onTarget: (target) => {
          if (target.turnId) activeTargetTurnId = target.turnId;
        },
        operationError: () => dispatcherModelError,
      },
    );
    const canonical = new AgentConversationStore({ butlerData });
    try {
      const sessions = canonical.listSessions();
      const messages =
        sessions.length === 1
          ? canonical.readMessages({ sessionId: sessions[0]!.id })
          : [];
      if (
        messages.length !== 4 ||
        Number(modelCalls) !== 1 ||
        unrelatedModelCalls !== 1 ||
        second.unrelatedHandled < 1 ||
        second.requestBytes !== Buffer.byteLength(secondText) ||
        second.admittedBytes !== Buffer.byteLength(S2) ||
        second.admittedText !== S2 ||
        second.requestSha256 !== sha(secondText) ||
        second.admittedSha256 !== sha(S2)
      )
        throw new Error(
          "dispatcher harness did not bind exact target after an unrelated reconciliation",
        );
      const binding = canonical.getGatewayBindingForConversation(
        second.conversationSessionId,
        "app",
      );
      const outcome = canonical.readTurnOutcome(second.conversationTurnId);
      if (
        !binding || !outcome ||
        binding.conversation_session_id !== second.conversationSessionId ||
        binding.external_session_id === second.conversationSessionId
      ) throw new Error("dispatcher canonical App binding is incomplete");
      expectedCanonicalSessionId = binding.conversation_session_id;
      expectedRuntimeSessionId = binding.external_session_id;
      const { ingestConversationMemory } = await import(
        "../../packages/butler-agent/src/agent/cognition/memory/projection/ingestion.ts",
      );
      const projection = await ingestConversationMemory({
        context: {
          butlerData,
          target: {
            kind: "active",
            expected_generation: descriptor.generation_id,
          },
          signal: new AbortController().signal,
        },
        source: {
          kind: "conversation_turn",
          session_id: second.conversationSessionId,
          turn_id: second.conversationTurnId,
          outcome_generation: outcome.generation,
        },
      });
      if (projection.source.state !== "complete") {
        throw new Error("dispatcher synthetic source projection did not complete");
      }
    } finally {
      canonical.close();
    }
    const memoryTarget = await sendAndDispatch(
      app.url,
      "합성 canonical memory 도구를 호출해 주세요.",
      dispatcher,
      dependencies,
      undefined,
      {
        butlerData,
        onTarget: (target) => {
          if (target.turnId) activeTargetTurnId = target.turnId;
        },
        operationError: () => dispatcherModelError,
      },
    );
    if (
      Number(modelCalls) !== 4 || memoryTarget.lastDispatch.failed !== 0 ||
      memoryToolTrace.read?.text !== S2
    ) throw new Error("dispatcher canonical memory flow did not complete");
    const continuation = await options?.afterReady?.({ dispatch: (text) => sendAndDispatch(app.url, text,
      dispatcher, dependencies, undefined, { butlerData, onTarget: (target) => { activeTargetTurnId = target.turnId; },
        operationError: () => dispatcherModelError }) });
    return {
      ok: true,
      claimed: second.lastDispatch.claimed,
      handled: second.lastDispatch.handled,
      failed: second.lastDispatch.failed,
      modelCalls,
      unrelatedModelCalls,
      unrelatedHandled: second.unrelatedHandled,
      requestBytes: second.requestBytes,
      admittedBytes: second.admittedBytes,
      requestSha256: second.requestSha256,
      admittedSha256: second.admittedSha256,
      canonicalTurnId: second.conversationTurnId,
      canonicalRequestMessageId: second.conversationRequestMessageId,
      runtimeSessionId: expectedRuntimeSessionId,
      canonicalSessionId: expectedCanonicalSessionId,
      memoryTools: {
        recallStatus: memoryToolTrace.recall.status,
        recallSourceCandidates:
          memoryToolTrace.recall.coverage.source.candidates,
        queryReturned: memoryToolTrace.query.returned,
        listedSessions: memoryToolTrace.list.returned,
        readMode: memoryToolTrace.read.mode,
        missingBindingCode: memoryToolTrace.missingBinding.code,
      },
      ...(continuation === undefined ? {} : { continuation }),
    };
  } finally {
    await composition.host.close();
    app.stop();
    bindings.close();
  }
}

export async function runMemoryRecoveryLiveHarness(
  dataRoot: string,
  bCorpusDir: string,
  recovery: LiveRecoveryMode = { kind: "accepted_pending" },
) {
  const butlerData = resolve(dataRoot);
  if (!dataRoot.trim()) throw new Error("--data-root is required");
  if (!existsSync(butlerData))
    throw new Error("live harness requires a coherent copy of accepted LIVE03");
  if (recovery.kind === "t4_actual_phase" &&
    (recovery.maxPollCalls > 512 || recovery.maxIngressPollCalls > 512 || recovery.maxWallClockMs > 20 * 60 * 1000)) {
    throw new Error("T4 actual limits exceed the reviewed allocation ceiling");
  }
  if (!bCorpusDir.trim() && recovery.kind !== "t4_actual_phase") throw new Error("--b-corpus-dir is required");
  const bSourceNames = recovery.kind === "t4_actual_phase" ? [] : recovery.kind === "preserved_completed_b_corpus" || recovery.kind === "preserved_failed_s3"
    ? ["b1.txt", "b2.txt", "b3.txt", "b4.txt", "b5.txt", "b6.txt", "b7.txt"]
    : ["b1.txt", "b2.txt", "b3.txt", "b4.txt"];
  const bSources = bSourceNames.map((name) =>
    readFileSync(resolve(bCorpusDir, name), "utf8"),
  );
  process.env.BUTLER_DATA = butlerData;
  if (resolve(process.env.BUTLER_DATA) !== butlerData) {
    throw new Error("live harness data root binding failed");
  }
  const configPath = `${butlerData}/butler.config.json`;
  if (!existsSync(configPath))
    throw new Error("accepted LIVE03 config missing");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const extractorModel = config.personalization?.profiling?.extractorModel;
  const extractorReasoning =
    config.personalization?.profiling?.extractorReasoningEffort;
  if (!extractorModel || !extractorReasoning)
    throw new Error("accepted LIVE03 extractor configuration missing");
  const descriptor = JSON.parse(
    readFileSync(
      `${butlerData}/cognition/memory/active-generation.json`,
      "utf8",
    ),
  );
  if (!descriptor?.generation_id)
    throw new Error("accepted LIVE03 generation missing");
  const graphPath = `${butlerData}/cognition/memory/generations/${descriptor.generation_id}/graph.sqlite`;
  const accepted = readAcceptedCorpusState(graphPath);
  const t4Remainder = recovery.kind === "t4_actual_phase" && recovery.resumeAfterQ1ReviewPath
    ? readT4ResumeAfterQ1(recovery.baselinePath, recovery.resumeAfterQ1ReviewPath,
      butlerData, descriptor.generation_id, graphPath)
    : null;
  const t4Baseline = recovery.kind === "t4_actual_phase"
    ? t4Remainder?.baseline ?? readT4ClosedBaseline(recovery.baselinePath, butlerData, descriptor.generation_id, graphPath)
    : null;
  const preservedFailure =
    recovery.kind === "preserved_failed_third"
      ? readAndValidatePreservedFailureBaseline(
          recovery.baselinePath,
          butlerData,
          descriptor.generation_id,
          graphPath,
        )
      : null;
  const completeContinuation = recovery.kind === "preserved_complete_three_pending_b1" || recovery.kind === "preserved_complete_three_failed_b1";
  const preservedComplete =
    completeContinuation
      ? readAndValidatePreservedCompleteBaseline(
          recovery.baselinePath,
          butlerData,
          descriptor.generation_id,
          graphPath,
          bSources[0]!,
          recovery.kind === "preserved_complete_three_failed_b1",
        )
      : null;
  const completedCorpus = recovery.kind === "preserved_completed_b_corpus" || recovery.kind === "preserved_failed_s3"
    ? readCompletedCorpusCheckpoint(recovery.baselinePath, butlerData, descriptor.generation_id, graphPath, bSources, recovery.kind === "preserved_failed_s3")
    : null;
  const failedS3 = completedCorpus?.failedS3;
  const preservedHistory = completedCorpus ?? preservedComplete;
  const expectedInitialJobs = t4Baseline ? t4Baseline.jobs.length : completedCorpus?.expectedJobs ?? preservedFailure?.expectedJobs ?? preservedComplete?.expectedJobs ?? 2;
  const expectedInitialPlans = t4Baseline?.completed.length ?? preservedHistory?.completed.length ?? 2;
  const expectedInitialWindows = t4Baseline
    ? t4Baseline.windows.filter((window) => window.state !== "replaced").length
    : completedCorpus?.expectedWindows ?? preservedComplete?.expectedWindows ?? expectedInitialJobs;
  const preRecallJobs = 3 + bSources.length;
  const expectedFinalJobs = preRecallJobs + 3;
  const minimumFinalWindows = expectedInitialWindows + expectedFinalJobs - expectedInitialJobs;
  const splitContinuation = Boolean(t4Baseline || completedCorpus) || preservedComplete?.splitAllocation === true;
  const newExtractorCallBudget = t4Baseline ? 0 : failedS3 ? 6 : completedCorpus ? (completedCorpus.targets.length === 7 ? 9 : 36) : splitContinuation
    ? preservedComplete!.newExtractorCallBudget
    : completeContinuation
      ? 21
      : preservedFailure
        ? 23
        : 24;
  if (
    accepted.completedPlans.length !== expectedInitialPlans ||
    accepted.jobs !== expectedInitialJobs ||
    accepted.windows !== expectedInitialWindows ||
    accepted.preservedSources !== 2
  )
    throw new Error("accepted LIVE03 completed plan/source baseline changed");

  const [
    { createProductionBtccComposition },
    { BtccInboundDispatcher, createBtccGatewayHandlers },
    { createAppTransportAdapter },
    { DeliveryGuard },
    { createGatewayServer },
    { GatewayRouter },
    { NativeInboundQueue },
    { createAppServer },
    { SessionBindingStore },
    { pollIteration },
    { AgentConversationStore },
    { conversationMessageText },
    { peek },
    { readOperationalMetricEvents },
  ] = await Promise.all([
    import("../../packages/butler-agent/src/agent/composition/index.ts"),
    import("../../packages/butler-agent/src/interfaces/gateway/btcc/index.ts"),
    import("../../packages/butler-agent/src/interfaces/transport/app/adapter.ts"),
    import("../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts"),
    import("../../packages/butler-agent/src/gateways/core/server.ts"),
    import("../../packages/butler-agent/src/gateways/core/router.ts"),
    import("../../packages/butler-agent/src/gateways/core/inbound-queue.ts"),
    import("../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts"),
    import("../../packages/butler-agent/src/test-support/harness/session-store.ts"),
    import("../../packages/butler-agent/src/agent/cognition/memory/scripts/sync-consumer.ts"),
    import("../../packages/butler-agent/src/agent/conversation/store.ts"),
    import("../../packages/butler-agent/src/agent/conversation/message-text.ts"),
    import("../../packages/butler-agent/src/agent/cognition/memory/scripts/queue.ts"),
    import("../../packages/butler-agent/src/operations/metrics/operational-metrics.ts"),
  ]);
  const pendingAtStart = peek(butlerData);
  if (
    recovery.kind === "accepted_pending" &&
    (!pendingAtStart ||
      pendingAtStart.schema_version !== "butler.memory-sync-request.v3")
  )
    throw new Error("accepted LIVE03 pending third source missing");
  if (
    (recovery.kind === "preserved_failed_third" ||
      completeContinuation || completedCorpus || t4Baseline) &&
    pendingAtStart
  )
    throw new Error(
      "preserved checkpoint must not have an unacknowledged memory source",
    );
  const failedVectorBaseline = failedVectorUnitIds(graphPath);
  const pollBudget: LivePollBudget =
    recovery.kind === "accepted_pending"
      ? {
          calls: 0,
          maxCalls: Number.POSITIVE_INFINITY,
          deadlineAt: Number.POSITIVE_INFINITY,
        }
      : createLivePollBudget(recovery.maxPollCalls, recovery.maxWallClockMs, splitContinuation);
  if (completedCorpus?.targets.length === 7 || t4Baseline) pollBudget.maxExtraLeaves = 1;
  const ingressBudget: IngressPollBudget =
    (completeContinuation || recovery.kind === "preserved_completed_b_corpus" || recovery.kind === "preserved_failed_s3" || recovery.kind === "t4_actual_phase")
      ? createIngressPollBudget(
          recovery.maxIngressPollCalls,
          pollBudget.deadlineAt,
        )
      : { calls: 0, maxCalls: 512, deadlineAt: pollBudget.deadlineAt };
  markExecutorReady(butlerData);

  const dbPath = `${butlerData}/app.sqlite`;
  const bindings = new SessionBindingStore(
    `${butlerData}/runtime/session-store.sqlite`,
    "ephemeral",
  );
  const toolTrace: {
    graphRecall?: any;
    hybridRecall?: any;
    graphPreference?: any;
    hybridPreference?: any;
    returnedReadArgs?: any;
    submittedReadArgs?: any;
    read?: any;
    rankingMetrics?: any[];
    s3Current?: any;
    s3Past?: any;
    s3ReadArgs?: any;
    s3SubmittedReadArgs?: any;
    s3Read?: any;
  } = {};
  let modelCalls = 0;
  let scriptPhase = failedS3 ? 8 : completedCorpus ? completedCorpus.targets.length - 3 : preservedComplete?.failedB1 ? 1 : 0;
  let activeTargetTurnId: string | null = null;
  let unexpectedModelRound: Error | null = null;
  let projectionPolls = 0;
  let rankingMetricStartedAt = 0;
  let comparison: { asOf: string; trace: unknown } | null = null;
  if (failedS3) {
    const previous = readPreservedS3Comparison(butlerData, failedS3);
    Object.assign(toolTrace, previous.toolTrace);
    comparison = previous.comparison;
    toolTrace.rankingMetrics = readOperationalMetricEvents({ butlerData, sinceTs: Date.parse(comparison.asOf) })
      .filter((event) => event.category === "memory" && event.name === "recall_v2_ranking" && event.dimensions?.cue_sha256 === sha(FIXED_B_CUE))
      .map((event) => ({ value: event.value, dimensions: event.dimensions }));
    if (![false, true].every((mode) => toolTrace.rankingMetrics!.some((event) => event.dimensions?.vector_executed === mode)))
      throw new Error("preserved comparison ranking metrics missing");
  }
  let correctionTimes: { pastAsOf: string; currentAsOf: string } | null = null;
  const scriptedModelRound: ModelRoundPort = {
    async runRound(request) {
      if (
        !activeTargetTurnId ||
        request.usageAttribution?.turnId !== activeTargetTurnId
      ) {
        unexpectedModelRound = new Error(
          "unexpected model round outside the admitted target",
        );
        throw unexpectedModelRound;
      }
      modelCalls += 1;
      scriptPhase += 1;
      if (scriptPhase >= 1 && scriptPhase <= 4)
        return final(`후속 합성 기억 ${scriptPhase}을 확인했습니다.`);
      if (scriptPhase === 5) {
        if (!comparison)
          throw new Error("fixed recall preconditions were not verified");
        rankingMetricStartedAt = Date.now();
        return tools([
          {
            id: "recall-graph-live",
            name: "recall_memory",
            args: {
              cue: FIXED_B_CUE,
              scope: "all_user_sessions",
              project_filter: "unassigned",
              include_internal: false,
              include_vector: false,
              limit: 6,
              as_of: comparison.asOf,
            },
          },
          {
            id: "recall-hybrid-live",
            name: "recall_memory",
            args: {
              cue: FIXED_B_CUE,
              scope: "all_user_sessions",
              project_filter: "unassigned",
              include_internal: false,
              include_vector: true,
              limit: 6,
              as_of: comparison.asOf,
            },
          },
        ]);
      }
      if (scriptPhase === 6) {
        toolTrace.graphRecall = toolOutputById(request, "recall-graph-live");
        toolTrace.hybridRecall = toolOutputById(request, "recall-hybrid-live");
        toolTrace.graphPreference = toolTrace.graphRecall.results.find(
          (result: any) =>
            result.evidence.some((item: any) => item.excerpt === S2),
        );
        toolTrace.hybridPreference = toolTrace.hybridRecall.results.find(
          (result: any) =>
            result.evidence.some((item: any) => item.excerpt === S2),
        );
        if (!toolTrace.graphPreference || !toolTrace.hybridPreference)
          throw new Error(
            "graph/hybrid recall did not both resolve S2 preference evidence",
          );
        if (!toolTrace.hybridPreference.channels.includes("vector"))
          throw new Error("hybrid S2 result has no actual vector contribution");
        toolTrace.rankingMetrics = readOperationalMetricEvents({
          butlerData,
          sinceTs: rankingMetricStartedAt,
        })
          .filter(
            (event) =>
              event.category === "memory" &&
              event.name === "recall_v2_ranking" &&
              event.dimensions?.cue_sha256 === sha(FIXED_B_CUE),
          )
          .map((event) => ({
            value: event.value,
            dimensions: event.dimensions,
          }));
        if (
          !toolTrace.rankingMetrics.some(
            (event: any) => event.dimensions?.vector_executed === false,
          ) ||
          !toolTrace.rankingMetrics.some(
            (event: any) => event.dimensions?.vector_executed === true,
          )
        )
          throw new Error(
            "graph/hybrid raw ranking metrics were not both recorded",
          );
        const candidateMetricKeys = new Set(
          toolTrace.rankingMetrics
            .filter(
              (event: any) => event.dimensions?.ranking_stage === "candidate",
            )
            .map(
              (event: any) =>
                `${event.dimensions.native_operation_sha256}:${event.dimensions.episode_sha256}`,
            ),
        );
        const returnedMetrics = toolTrace.rankingMetrics.filter(
          (event: any) => event.dimensions?.ranking_stage === "returned",
        );
        if (
          !returnedMetrics.length ||
          returnedMetrics.some(
            (event: any) =>
              !candidateMetricKeys.has(
                `${event.dimensions.native_operation_sha256}:${event.dimensions.episode_sha256}`,
              ),
          )
        )
          throw new Error(
            "returned ranking metrics do not join their pre-hydration candidates",
          );
        const preferenceEvidence = toolTrace.hybridPreference.evidence.find(
          (item: any) => item.excerpt === S2,
        );
        toolTrace.returnedReadArgs = preferenceEvidence.read_args;
        return tool(
          "read-live",
          "read_conversation_session",
          structuredClone(toolTrace.returnedReadArgs),
        );
      }
      if (scriptPhase === 7) {
        toolTrace.submittedReadArgs = toolCallById(
          request,
          "read-live",
        ).arguments;
        toolTrace.read = lastToolOutput(request, "read_conversation_session");
        return final(
          "Luna의 파란 공 선호 근거를 canonical source에서 확인했습니다.",
        );
      }
      if (scriptPhase === 8) return final("정정 내용을 기록했습니다.");
      if (scriptPhase === 9) {
        if (!correctionTimes)
          throw new Error("S3 correction times were not bound");
        return tools([
          {
            id: "recall-s3-current",
            name: "recall_memory",
            args: {
              cue: S3_QUERY,
              scope: "all_user_sessions",
              project_filter: "unassigned",
              include_internal: false,
              include_vector: true,
              limit: 6,
              as_of: correctionTimes.currentAsOf,
            },
          },
          {
            id: "recall-s3-past",
            name: "recall_memory",
            args: {
              cue: S3_QUERY,
              scope: "all_user_sessions",
              project_filter: "unassigned",
              include_internal: false,
              include_vector: true,
              limit: 6,
              as_of: correctionTimes.pastAsOf,
            },
          },
        ]);
      }
      if (scriptPhase === 10) {
        toolTrace.s3Current = toolOutputById(request, "recall-s3-current");
        toolTrace.s3Past = toolOutputById(request, "recall-s3-past");
        const current = toolTrace.s3Current.results.find((result: any) =>
          result.evidence.some((item: any) => item.excerpt === S3),
        );
        const past = toolTrace.s3Past.results.find((result: any) =>
          result.evidence.some((item: any) => item.excerpt === S2),
        );
        if (
          !current ||
          !past ||
          toolTrace.s3Current.results.some((result: any) =>
            result.evidence.some((item: any) => item.excerpt === S2),
          ) ||
          toolTrace.s3Past.results.some((result: any) =>
            result.evidence.some((item: any) => item.excerpt === S3),
          )
        )
          throw new Error("S3 current/past recall validity mismatch");
        toolTrace.s3ReadArgs = current.evidence.find(
          (item: any) => item.excerpt === S3,
        ).read_args;
        return tool(
          "read-s3",
          "read_conversation_session",
          structuredClone(toolTrace.s3ReadArgs),
        );
      }
      if (scriptPhase === 11) {
        toolTrace.s3SubmittedReadArgs = toolCallById(
          request,
          "read-s3",
        ).arguments;
        toolTrace.s3Read = lastToolOutput(request, "read_conversation_session");
        return final(
          "현재는 Luna가 빨간 공을 좋아한다는 일본어 정정 원문을 확인했습니다.",
        );
      }
      throw new Error("unexpected model round");
    },
  };
  const t4Observer = t4Baseline ? createT4PhaseObserver(
    (await import("../../packages/butler-agent/src/integrations/providers/runtime.ts")).createProviderModelRoundPort(),
    () => activeTargetTurnId,
    pollBudget.deadlineAt,
    butlerData,
    t4Baseline.resume.preserved_observation,
    recovery.kind === "t4_actual_phase" ? recovery.performance : undefined,
  ) : null;
  const modelRound = t4Observer?.port ?? scriptedModelRound;
  const app = createAppServer({
    dbPath,
    butlerData,
    butlerHome: process.cwd(),
    port: 0,
    automationSchedulerIntervalMs: false,
  });
  const composition = createProductionBtccComposition({
    butlerHome: process.cwd(),
    butlerData,
    ownerId: `memory-live:${process.pid}`,
    modelRound,
    sessionBindings: bindings,
    appServerUrl: app.url,
  });
  const gateway = createGatewayServer({
    router: new GatewayRouter({ store: bindings }),
    handlers: createBtccGatewayHandlers({
      btcc: composition.btcc,
      ...(t4Baseline ? { subsessionDelegation: composition.subsessions } : {}),
    }),
    butlerData,
  });
  const dispatcher = new BtccInboundDispatcher();
  const queue = new NativeInboundQueue(butlerData);
  const deliveryGuard = new DeliveryGuard({
    adapters: [createAppTransportAdapter()],
    butlerData,
  });
  const syncAppProjection = async () => {
    await app.store.waitForAppTransportProjection();
    while (app.store.syncNextAppTransportBatch()) {
      /* drain the actual App transport owner */
    }
  };
  const dispatchTarget = async (text: string, resume?: AppTarget, admission?: T4AppAdmission,
    budgets?: { poll: LivePollBudget; ingress: IngressPollBudget }) => {
    const delivered = await sendAndDispatch(
      app.url,
      text,
      dispatcher,
      { queue, server: gateway, store: bindings, deliveryGuard },
      budgets?.poll ?? pollBudget,
      {
        ...admission,
        butlerData,
        ingressBudget: budgets?.ingress ?? ingressBudget,
        resume,
        onTarget: (target) => {
          activeTargetTurnId = target.turnId;
        },
        operationError: () => unexpectedModelRound,
        syncProjection: syncAppProjection,
      },
    );
    activeTargetTurnId = null;
    return delivered;
  };

  try {
    await composition.ready;
    assertLiveWallBudget(pollBudget);
    if (t4Baseline && t4Observer) {
      const terminalReplays = t4Remainder ? Number(t4Remainder.q1.trace.terminal_replays ?? 0)
        : await drainT4PreservedTerminalReplays({
          root: butlerData,
          baseline: t4Baseline,
          dispatcher,
          dependencies: { queue, server: gateway, store: bindings, deliveryGuard },
          syncProjection: syncAppProjection,
          budget: ingressBudget,
        });
      return await runT4ActualPhaseBranch({
        butlerData, graphPath, generationId: descriptor.generation_id,
        appUrl: app.url, baseline: t4Baseline, observer: t4Observer,
        dispatch: (text, admission, budgets) => dispatchTarget(text, undefined, admission, budgets),
        pollBudget, ingressBudget, terminalReplays,
        performance: recovery.kind === "t4_actual_phase" ? recovery.performance : undefined,
        q1Resume: t4Remainder?.q1,
      });
    }
    const bTargets: DeliveredTarget[] = [];
    let bStartIndex = 0;
    if (completedCorpus) {
      for (const target of completedCorpus.targets) {
        const delivered = await readDeliveredTarget(app.url, target, butlerData,
          { claimed: 0, handled: 0, failed: 0, interrupted: 0 }, 0);
        if (!delivered) throw new Error("preserved completed B App/canonical source changed");
        bTargets.push(delivered);
      }
      bStartIndex = completedCorpus.targets.length;
    } else if (preservedFailure && recovery.kind === "preserved_failed_third") {
      projectionPolls += await recoverPreservedFailedWindow({
        butlerData,
        graphPath,
        failedAtStart: failedVectorBaseline,
        poll: pollIteration,
        expected: preservedFailure,
        budget: pollBudget,
      });
      assertPreservedFailureRecovery(graphPath, preservedFailure);
    } else if (
      preservedComplete &&
      completeContinuation
    ) {
      if (preservedComplete.failedB1) {
        const expected = preservedComplete.failedB1;
        const delivered = await readDeliveredTarget(app.url, preservedComplete.pendingB1.target, butlerData,
          { claimed: 0, handled: 0, failed: 0, interrupted: 0 }, 0);
        if (!delivered || delivered.conversationRequestMessageId !== expected.canonicalRequestId ||
          delivered.conversationTurnId !== expected.canonicalTurnId || delivered.conversationSessionId !== expected.canonicalSessionId)
          throw new Error("preserved delivered B1 canonical binding changed");
        bTargets.push(delivered);
        const command = Bun.spawnSync([process.execPath, "run", "packages/butler-agent/src/agent/cognition/memory/scripts/consolidation-cycle.ts",
          "--memory-reprocess-window", "--input", expected.requestPath], { cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe" });
        if (command.exitCode !== 0) throw new Error(`explicit B1 reprocess failed: ${command.stderr.toString().trim()}`);
        const receipt = JSON.parse(command.stdout.toString().trim());
        if (receipt.ok !== true || receipt.window_ref !== expected.windowRef || receipt.job_id !== expected.jobId ||
          receipt.cumulative_attempt_count !== expected.attemptCount || receipt.recovery_attempt_count !== 0 || receipt.budget !== (expected.splitExpected ? 0 : 3) || receipt.replayed !== false || receipt.state !== (expected.splitExpected ? "replaced" : "pending"))
          throw new Error("explicit B1 reprocess receipt mismatch");
        const check = new Database(graphPath, { readonly: true });
        try {
          const window = check.query<any, [string]>("SELECT state,attempt_count,recovery_revision,recovery_base_attempt_count,input_json FROM memory_projection_windows WHERE window_ref=?").get(expected.windowRef);
          if (!window || window.state !== (expected.splitExpected ? "replaced" : "pending") || window.attempt_count !== expected.attemptCount || window.recovery_base_attempt_count !== expected.attemptCount ||
            window.recovery_revision !== receipt.recovery_revision || sha(window.input_json) !== expected.inputJsonSha256)
            throw new Error("explicit B1 reprocess changed pinned input or budget");
          if (expected.splitExpected) {
            if (receipt.action !== "split" || receipt.children?.length !== 2 || receipt.children.some((child: any) => child.state !== "pending" || child.budget !== 3 || child.cumulative_attempt_count !== 0 || child.recovery_attempt_count !== 0))
              throw new Error("explicit B1 split child allocation mismatch");
          }
          {
            const before = JSON.stringify(check.query("SELECT * FROM memory_projection_windows WHERE job_id=? ORDER BY window_ref").all(expected.jobId));
            const attempts = JSON.stringify(check.query("SELECT * FROM memory_projection_attempts WHERE job_id=? ORDER BY attempt_ref").all(expected.jobId));
            const replay = Bun.spawnSync([process.execPath, "run", "packages/butler-agent/src/agent/cognition/memory/scripts/consolidation-cycle.ts", "--memory-reprocess-window", "--input", expected.requestPath],
              { cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe" });
            if (replay.exitCode !== 0) throw new Error("explicit B1 reprocess replay failed");
            const observed = JSON.parse(replay.stdout.toString().trim());
            if (!observed.replayed || observed.action !== receipt.action || observed.recovery_revision !== receipt.recovery_revision ||
              observed.cumulative_attempt_count !== receipt.cumulative_attempt_count || observed.recovery_attempt_count !== 0 || JSON.stringify(observed.children) !== JSON.stringify(receipt.children) ||
              JSON.stringify(check.query("SELECT * FROM memory_projection_windows WHERE job_id=? ORDER BY window_ref").all(expected.jobId)) !== before ||
              JSON.stringify(check.query("SELECT * FROM memory_projection_attempts WHERE job_id=? ORDER BY attempt_ref").all(expected.jobId)) !== attempts)
              throw new Error("explicit B1 reprocess replay mutated history or budget");
          }
        } finally { check.close(); }
      } else {
        bTargets.push(await dispatchTarget(bSources[0]!, preservedComplete.pendingB1.target));
      }
      projectionPolls += await requireProjectionPoll(
        butlerData,
        graphPath,
        4,
        failedVectorBaseline,
        pollIteration,
        pollBudget,
      );
      bStartIndex = 1;
    } else {
      projectionPolls += await requireProjectionPoll(
        butlerData,
        graphPath,
        3,
        failedVectorBaseline,
        pollIteration,
        pollBudget,
      );
      if (pendingAtStart && peek(butlerData)?.job_id === pendingAtStart.job_id)
        throw new Error("accepted LIVE03 pending source was not consumed");
    }
    for (let index = bStartIndex; index < bSources.length; index += 1) {
      bTargets.push(await dispatchTarget(bSources[index]!));
      projectionPolls += await requireProjectionPoll(
        butlerData,
        graphPath,
        4 + index,
        failedVectorBaseline,
        pollIteration,
        pollBudget,
      );
    }
    if (!failedS3) projectionPolls += await requireS2EpisodeVector(
      butlerData,
      graphPath,
      preRecallJobs,
      failedVectorBaseline,
      pollIteration,
      pollBudget,
    );
    const bGraphSources = resolveBoundBGraphSources(graphPath, bTargets, bSources.length);
    if (!failedS3) {
      comparison = await verifyLiveRecallPreconditions({
        butlerData,
        graphPath,
        generationId: descriptor.generation_id,
        accepted,
        bSources: bGraphSources,
        preservedPlanCount: expectedInitialPlans,
        expectedJobs: preRecallJobs,
        maxExtraLeaves: pollBudget.maxExtraLeaves ?? 0,
      });
      await dispatchTarget(
        "내 고양이가 좋아하는 장난감은 무엇인가요? canonical 근거를 읽어 주세요.",
      );
      projectionPolls += await requireProjectionPoll(
        butlerData,
        graphPath,
        preRecallJobs + 1,
        failedVectorBaseline,
        pollIteration,
        pollBudget,
      );
      await dispatchTarget(S3);
    } else {
      for (const target of [failedS3.queryTarget, failedS3.target]) {
        const delivered = await readDeliveredTarget(app.url, target, butlerData,
          { claimed: 0, handled: 0, failed: 0, interrupted: 0 }, 0);
        if (!delivered || (target === failedS3.target && delivered.conversationRequestMessageId !== failedS3.canonicalRequestId))
          throw new Error("preserved comparison/S3 App source changed");
      }
      const { reprocessMemoryProjectionWindow } = await import(
        "../../packages/butler-agent/src/agent/cognition/memory/projection/ingestion.ts");
      const receipt = reprocessMemoryProjectionWindow({
        context: { butlerData, target: { kind: "active", expected_generation: descriptor.generation_id }, signal: new AbortController().signal },
        request: failedS3.request,
      });
      if (!receipt.ok || receipt.replayed || receipt.action !== "retry" || receipt.state !== "pending" ||
        receipt.window_ref !== failedS3.request.window_ref || receipt.job_id !== failedS3.request.job_id ||
        receipt.cumulative_attempt_count !== failedS3.request.expected_attempt_count || receipt.recovery_attempt_count !== 0 || receipt.budget !== 3)
        throw new Error("failed S3 recovery receipt mismatch");
      const check = new Database(graphPath, { readonly: true });
      try {
        const row = check.query<any, [string]>("SELECT input_json,recovery_revision,recovery_base_attempt_count FROM memory_projection_windows WHERE window_ref=?").get(receipt.window_ref);
        if (!row || sha(row.input_json) !== failedS3.inputJsonSha256 || row.recovery_revision !== receipt.recovery_revision ||
          row.recovery_base_attempt_count !== failedS3.request.expected_attempt_count)
          throw new Error("failed S3 recovery changed pinned input or budget");
      } finally { check.close(); }
    }
    const pastAsOf = readSourceInstant(graphPath, sha(S2));
    projectionPolls += await requireProjectionPoll(
      butlerData,
      graphPath,
      preRecallJobs + 2,
      failedVectorBaseline,
      pollIteration,
      pollBudget,
    );
    const s3ObservedAt = readSourceInstant(graphPath, sha(S3));
    if (Date.parse(s3ObservedAt) <= Date.parse(pastAsOf))
      throw new Error("S3 observed_at does not follow S2");
    correctionTimes = {
      pastAsOf,
      currentAsOf: new Date(Date.parse(s3ObservedAt) + 1).toISOString(),
    };
    await dispatchTarget(S3_QUERY);
    projectionPolls += await requireProjectionPoll(
      butlerData,
      graphPath,
      preRecallJobs + 3,
      failedVectorBaseline,
      pollIteration,
      pollBudget,
    );

    // Public handles stay unchanged at the tool boundary; SQL joins use their stored source IDs.
    const [s2ReadSourceId, s3ReadSourceId] = [toolTrace.read, toolTrace.s3Read].map((result) => {
      const parts = result.source_ref.split(":");
      if (parts.length !== 4 || parts[0] !== "memory-source" || parts[1] !== "v2" ||
          Buffer.from(parts[2]!, "base64url").toString("utf8") !== descriptor.generation_id) {
        throw new Error("native source handle generation mismatch");
      }
      return Buffer.from(parts[3]!, "base64url").toString("utf8");
    });
    const bSourceIds = bGraphSources.map((source) => source.sourceId);
    const bCanonicalHashes = bGraphSources.map((source) => source.contentHash);
    const db = new Database(graphPath, { readonly: true });
    let evidence: Array<Record<string, unknown>>;
    let attempts: Array<{
      window_ref: string;
      attempt_count: number;
      state: string;
      error_code: string | null;
      input_sha256: string | null;
      provider_evidence_json: string | null;
      attempt_kind: string;
      provider_invoked: number;
      outcome_known: number;
      invocation_ref: string | null;
    }>;
    let counts: Record<string, number>;
    let linkage: Record<string, string>;
    let correctionSource: { episode_id: string; revision: string };
    let correctionBinding: {
      old_claim_id: string;
      new_claim_id: string;
      old_likes_edge_id: string;
      new_likes_edge_id: string;
      supersedes_edge_id: string;
      subject_node_id: string;
      old_object_node_id: string;
      new_object_node_id: string;
    };
    try {
      evidence = db
        .query<{ provider_evidence_json: string }, []>(
          "SELECT provider_evidence_json FROM memory_projection_windows WHERE provider_evidence_json IS NOT NULL ORDER BY rowid",
        )
        .all()
        .map((row) => JSON.parse(row.provider_evidence_json));
      attempts = db
        .query<
          {
            window_ref: string;
            attempt_count: number;
            state: string;
            error_code: string | null;
            input_sha256: string | null;
            provider_evidence_json: string | null;
            attempt_kind: string;
            provider_invoked: number;
            outcome_known: number;
            invocation_ref: string | null;
          },
          []
        >(
          `
        SELECT window_ref,attempt_count,state,error_code,input_sha256,provider_evidence_json,attempt_kind,provider_invoked,outcome_known,invocation_ref
        FROM memory_projection_attempts ORDER BY recorded_at,window_ref,attempt_count,state
      `,
        )
        .all();
      const s2Source = db
        .query<
          { source_id: string; observed_at: string },
          [string]
        >("SELECT source_id,observed_at FROM memory_chunk_sources WHERE content_hash=? AND byte_end-byte_start=25 ORDER BY observed_at LIMIT 1")
        .get(sha(S2));
      if (!s2Source) throw new Error("preserved S2 source missing");
      for (let index = 0; index < bSourceIds.length; index += 1) {
        const bound = db
          .query<
            { content_hash: string },
            [string]
          >("SELECT content_hash FROM memory_chunk_sources WHERE source_id=?")
          .get(bSourceIds[index]!);
        if (!bound || bound.content_hash !== bCanonicalHashes[index])
          throw new Error("B canonical source identity/hash binding mismatch");
      }
      counts = {
        episodes: Number(
          db
            .query<{ n: number }, []>("SELECT COUNT(*) n FROM memory_chunks")
            .get()!.n,
        ),
        later_distinct_mentions: Number(
          db
            .query<{ n: number }, string[]>(
              `
          SELECT COUNT(*) n FROM (SELECT DISTINCT m.entity_id,m.source_id FROM entity_mentions m
          JOIN memory_chunk_sources s ON s.source_id=m.source_id
          WHERE s.observed_at>? AND s.source_id!=? AND s.source_id IN (${bSourceIds.map(() => "?").join(",")}))
        `,
            )
            .get(s2Source.observed_at, s2Source.source_id, ...bSourceIds)!.n,
        ),
        b_sources: Number(
          db
            .query<{ n: number }, string[]>(
              `
            SELECT COUNT(DISTINCT source_id) n FROM memory_chunk_sources
            WHERE source_id IN (${bSourceIds.map(() => "?").join(",")})
          `,
            )
            .get(...bSourceIds)!.n,
        ),
        b_completed_plans: Number(
          db
            .query<{ n: number }, string[]>(
              `
          SELECT COUNT(DISTINCT w.window_ref) n FROM memory_projection_windows w
          JOIN json_each(w.source_refs_json) refs ON true JOIN memory_chunk_sources s ON s.source_id=refs.value
          WHERE s.source_id IN (${bSourceIds.map(() => "?").join(",")}) AND w.state='complete'
            AND w.normalized_plan_json IS NOT NULL AND w.provider_evidence_json IS NOT NULL
        `,
            )
            .get(...bSourceIds)!.n,
        ),
        aliases: Number(
          db
            .query<{ n: number }, []>("SELECT COUNT(*) n FROM entity_aliases")
            .get()!.n,
        ),
        alias_surfaces: Number(
          db
            .query<
              { n: number },
              []
            >("SELECT COUNT(DISTINCT surface_original) n FROM entity_aliases WHERE surface_original IN ('루나','Luna')")
            .get()!.n,
        ),
        shared_alias_entity: Number(
          db
            .query<
              { n: number },
              []
            >("SELECT COUNT(*) n FROM (SELECT entity_id FROM entity_aliases WHERE surface_original IN ('루나','Luna') GROUP BY entity_id HAVING COUNT(DISTINCT surface_original)=2)")
            .get()!.n,
        ),
        likes: Number(
          db
            .query<
              { n: number },
              []
            >("SELECT COUNT(*) n FROM edges WHERE rel_type='likes'")
            .get()!.n,
        ),
        has_subject: Number(
          db
            .query<
              { n: number },
              []
            >("SELECT COUNT(*) n FROM edges WHERE rel_type='has_subject'")
            .get()!.n,
        ),
        has_object: Number(
          db
            .query<
              { n: number },
              []
            >("SELECT COUNT(*) n FROM edges WHERE rel_type='has_object'")
            .get()!.n,
        ),
        likes_evidence: Number(
          db
            .query<
              { n: number },
              []
            >("SELECT COUNT(*) n FROM edge_evidence ee JOIN edges e ON e.edge_id=ee.edge_id WHERE e.rel_type='likes'")
            .get()!.n,
        ),
        reused_luna_likes: Number(
          db
            .query<
              { n: number },
              []
            >("SELECT COUNT(DISTINCT e.edge_id) n FROM edges e JOIN entity_aliases a ON a.entity_id=e.source_node_id WHERE e.rel_type='likes' AND a.surface_original='Luna'")
            .get()!.n,
        ),
        s2_typed_claim_support: Number(
          db
            .query<
              { n: number },
              [string]
            >("SELECT COUNT(DISTINCT e.claim_node_id) n FROM edges e JOIN edge_evidence ee ON ee.edge_id=e.edge_id JOIN memory_chunk_sources s ON s.source_id=ee.chunk_source_id WHERE s.source_id=? AND e.rel_type IN ('likes','has_subject','has_object') GROUP BY e.claim_node_id HAVING COUNT(DISTINCT e.rel_type)=3")
            .get(s2ReadSourceId!)?.n ?? 0,
        ),
        s3_supersedes: Number(
          db
            .query<{ n: number }, [string, string]>(
              `
          SELECT COUNT(DISTINCT correction.edge_id) n
          FROM edges old_claim
          JOIN edge_evidence old_evidence ON old_evidence.edge_id=old_claim.edge_id
          JOIN edges correction ON correction.target_node_id=old_claim.claim_node_id AND correction.rel_type='supersedes'
          JOIN edge_evidence correction_evidence ON correction_evidence.edge_id=correction.edge_id
          WHERE old_claim.rel_type='likes' AND old_evidence.chunk_source_id=?
            AND correction.source_node_id=correction.claim_node_id
            AND correction_evidence.chunk_source_id=?
        `,
            )
            .get(s2ReadSourceId!, s3ReadSourceId!)?.n ??
            0,
        ),
      };
      const correctionRows = db
        .query<typeof correctionBinding, string[]>(
          `
        SELECT old_likes.claim_node_id old_claim_id,new_likes.claim_node_id new_claim_id,
          old_likes.edge_id old_likes_edge_id,new_likes.edge_id new_likes_edge_id,
          correction.edge_id supersedes_edge_id,old_likes.source_node_id subject_node_id,
          old_likes.target_node_id old_object_node_id,new_likes.target_node_id new_object_node_id
        FROM edges old_likes
        JOIN edges old_subject ON old_subject.claim_node_id=old_likes.claim_node_id AND old_subject.rel_type='has_subject'
          AND old_subject.source_node_id=old_likes.claim_node_id AND old_subject.target_node_id=old_likes.source_node_id
        JOIN edges old_object ON old_object.claim_node_id=old_likes.claim_node_id AND old_object.rel_type='has_object'
          AND old_object.source_node_id=old_likes.claim_node_id AND old_object.target_node_id=old_likes.target_node_id
        JOIN edges correction ON correction.target_node_id=old_likes.claim_node_id AND correction.rel_type='supersedes'
          AND correction.source_node_id=correction.claim_node_id
        JOIN edges new_likes ON new_likes.claim_node_id=correction.source_node_id AND new_likes.rel_type='likes'
          AND new_likes.source_node_id=old_likes.source_node_id
        JOIN edges new_subject ON new_subject.claim_node_id=new_likes.claim_node_id AND new_subject.rel_type='has_subject'
          AND new_subject.source_node_id=new_likes.claim_node_id AND new_subject.target_node_id=new_likes.source_node_id
        JOIN edges new_object ON new_object.claim_node_id=new_likes.claim_node_id AND new_object.rel_type='has_object'
          AND new_object.source_node_id=new_likes.claim_node_id AND new_object.target_node_id=new_likes.target_node_id
        WHERE old_likes.rel_type='likes' AND old_likes.target_node_id!=new_likes.target_node_id
          AND EXISTS(SELECT 1 FROM edge_evidence ee WHERE ee.edge_id=old_likes.edge_id AND ee.chunk_source_id=?)
          AND EXISTS(SELECT 1 FROM edge_evidence ee WHERE ee.edge_id=old_subject.edge_id AND ee.chunk_source_id=?)
          AND EXISTS(SELECT 1 FROM edge_evidence ee WHERE ee.edge_id=old_object.edge_id AND ee.chunk_source_id=?)
          AND EXISTS(SELECT 1 FROM edge_evidence ee WHERE ee.edge_id=correction.edge_id AND ee.chunk_source_id=?)
          AND EXISTS(SELECT 1 FROM edge_evidence ee WHERE ee.edge_id=new_likes.edge_id AND ee.chunk_source_id=?)
          AND EXISTS(SELECT 1 FROM edge_evidence ee WHERE ee.edge_id=new_subject.edge_id AND ee.chunk_source_id=?)
          AND EXISTS(SELECT 1 FROM edge_evidence ee WHERE ee.edge_id=new_object.edge_id AND ee.chunk_source_id=?)
        ORDER BY old_likes.edge_id,new_likes.edge_id,correction.edge_id
      `,
        )
        .all(
          s2ReadSourceId!,
          s2ReadSourceId!,
          s2ReadSourceId!,
          s3ReadSourceId!,
          s3ReadSourceId!,
          s3ReadSourceId!,
          s3ReadSourceId!,
        );
      if (correctionRows.length !== 1)
        throw new Error(
          `S3 exact correction binding mismatch: ${correctionRows.length}`,
        );
      correctionBinding = correctionRows[0]!;
      correctionSource = db.query<{ episode_id: string; revision: string }, [string]>(
        "SELECT episode_id,revision FROM memory_chunk_sources WHERE source_id=?",
      ).get(s3ReadSourceId!)!;
      if (!correctionSource) throw new Error("S3 correction source owner missing");
      linkage = db
        .query<
          {
            source_id: string;
            episode_id: string;
            revision: string;
            job_id: string;
            window_ref: string;
            conversation_session_id: string;
            conversation_turn_id: string;
            observed_completion_job_ids: string;
            normalized_plan_json: string;
          },
          [string]
        >(
          "SELECT s.source_id,s.episode_id,s.revision,j.job_id,w.window_ref,c.conversation_session_id,c.conversation_turn_id,j.observed_completion_job_ids,w.normalized_plan_json FROM memory_chunk_sources s JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id JOIN memory_projection_jobs j ON j.episode_id=s.episode_id AND j.revision=s.revision JOIN memory_projection_windows w ON w.job_id=j.job_id JOIN json_each(w.source_refs_json) refs ON refs.value=s.source_id WHERE s.source_id=?",
        )
        .get(s2ReadSourceId!)!;
    } finally {
      db.close();
    }
    if (
      counts.episodes !== expectedFinalJobs ||
      counts.later_distinct_mentions < 250 ||
      counts.b_sources !== bSourceIds.length ||
      counts.b_completed_plans !== bSourceIds.length ||
      counts.alias_surfaces < 2 ||
      counts.shared_alias_entity !== 1 ||
      counts.likes < 1 ||
      counts.likes_evidence < 1 ||
      counts.reused_luna_likes < 1 ||
      counts.has_subject < 1 ||
      counts.has_object < 1 ||
      counts.s2_typed_claim_support < 1 ||
      counts.s3_supersedes < 1
    ) {
      throw new Error(
        `typed graph acceptance failed: ${JSON.stringify(counts)}`,
      );
    }
    const providerInvocationRefs = new Set(
      attempts
        .filter(
          (attempt) =>
            attempt.provider_invoked === 1 && attempt.attempt_kind !== "legacy",
        )
        .map((attempt) => attempt.invocation_ref)
        .filter((value): value is string => Boolean(value)),
    );
    const newProviderInvocationRefs = new Set(
      [...providerInvocationRefs].filter(
        (ref) =>
          !preservedHistory?.historicalProviderInvocationRefs.includes(ref),
      ),
    );
    const finalWindowCount = countActiveProjectionWindows(graphPath);
    if (
      projectionPolls < minimumFinalWindows - expectedInitialPlans ||
      finalWindowCount < minimumFinalWindows || finalWindowCount > expectedFinalJobs + (pollBudget.maxExtraLeaves ?? 0) ||
      newProviderInvocationRefs.size < minimumFinalWindows - expectedInitialPlans
    ) {
      throw new Error("memory live projection attempt count mismatch");
    }
    if (newProviderInvocationRefs.size > newExtractorCallBudget) throw new Error("actual extractor call allocation exceeded");
    assertLiveWallBudget(pollBudget);
    if (preservedHistory)
      assertPreservedCompleteHistory(graphPath, preservedHistory);
    const after = readAcceptedCorpusState(graphPath);
    if (
      after.preservedSources !== 2 ||
      !preservesCompletedPlans(after.completedPlans, accepted.completedPlans)
    )
      throw new Error("accepted LIVE03 successful plans were rewritten");
    const claimPath = toolTrace.graphPreference.association_path.find(
      (edge: any) =>
        ["likes", "has_subject", "has_object"].includes(edge.relation),
    );
    if (!claimPath) {
      throw new Error("native claim seed did not return a typed graph path");
    }
    if (
      toolTrace.read?.mode !== "source" ||
      JSON.stringify(toolTrace.returnedReadArgs) !==
        JSON.stringify(toolTrace.submittedReadArgs)
    ) {
      throw new Error(
        "native source read did not complete from unchanged recall read_args",
      );
    }
    if (
      toolTrace.s3Read?.mode !== "source" ||
      JSON.stringify(toolTrace.s3ReadArgs) !==
        JSON.stringify(toolTrace.s3SubmittedReadArgs)
    )
      throw new Error(
        "S3 native source read did not preserve recall read_args",
      );
    const canonical = new AgentConversationStore({ butlerData });
    let canonicalS2: string;
    let canonicalS3: string;
    let outcomeId: string;
    try {
      const message = canonical.readMessageById(
        toolTrace.read.conversation_message_id,
      );
      canonicalS2 = message ? conversationMessageText(message) : "";
      const s3Message = canonical.readMessageById(
        toolTrace.s3Read.conversation_message_id,
      );
      canonicalS3 = s3Message ? conversationMessageText(s3Message) : "";
      outcomeId =
        canonical.readTurnOutcome(linkage.conversation_turn_id)?.id ?? "";
    } finally {
      canonical.close();
    }
    if (
      canonicalS2 !== S2 ||
      !outcomeId ||
      toolTrace.read.text !== canonicalS2 ||
      toolTrace.read.source_hash !== sha(canonicalS2) ||
      toolTrace.read.byte_start !== 0 ||
      toolTrace.read.byte_end !== Buffer.byteLength(canonicalS2, "utf8")
    ) {
      throw new Error("native source read does not match canonical S2 scalar");
    }
    if (
      canonicalS3 !== S3 ||
      toolTrace.s3Read.text !== canonicalS3 ||
      toolTrace.s3Read.source_hash !== sha(canonicalS3) ||
      toolTrace.s3Read.byte_start !== 0 ||
      toolTrace.s3Read.byte_end !== Buffer.byteLength(canonicalS3, "utf8")
    )
      throw new Error("native source read does not match canonical S3 scalar");
    const currentBound = toolTrace.s3Current.results.find(
      (result: any) =>
        result.episode_ref === correctionSource.episode_id &&
        result.revision === correctionSource.revision &&
        result.evidence.some(
          (item: any) => item.source_ref === toolTrace.s3Read.source_ref,
        ),
    );
    const pastBound = toolTrace.s3Past.results.find(
      (result: any) =>
        result.episode_ref === linkage.episode_id &&
        result.revision === linkage.revision &&
        result.evidence.some(
          (item: any) => item.source_ref === toolTrace.read.source_ref,
        ),
    );
    if (!currentBound || !pastBound)
      throw new Error(
        "native current/past results do not bind the exact replacement claims and sources",
      );
    if (!comparison) throw new Error("comparison evidence missing");
    const trace = {
      schema: "butler.memory-recovery-t2-live-trace.v1",
      data_root: butlerData,
      generation_id: descriptor.generation_id,
      preserved_live03_jobs: expectedInitialPlans,
      pending_live03_sources_processed:
        recovery.kind === "accepted_pending" ? 1 : 0,
      resumed_pending_b1_targets:
        recovery.kind === "preserved_complete_three_pending_b1" ? 1 : 0,
      reprocessed_failed_b1_windows: preservedComplete?.failedB1 ? 1 : 0,
      reprocessed_failed_s3_windows: failedS3 ? 1 : 0,
      comparison_execution: failedS3 ? "preserved_actual11" : "current_execution",
      b_app_ingress_turns:
        completedCorpus ? bSources.length - completedCorpus.targets.length : completeContinuation ? 3 : 4,
      new_app_posts:
        failedS3 ? 1 : completedCorpus ? bSources.length - completedCorpus.targets.length + 3 : completeContinuation ? 6 : 7,
      new_canonical_sources: failedS3 ? 1 : completedCorpus ? bSources.length - completedCorpus.targets.length + 3 : preservedComplete?.failedB1 ? 6 : 7,
      processing_obligations:
        minimumFinalWindows - expectedInitialPlans,
      ingress_poll_budget: {
        used: ingressBudget.calls,
        max: ingressBudget.maxCalls,
      },
      b_source_bindings: bTargets.map((target) => ({
        request_sha256: target.requestSha256,
        admitted_sha256: target.admittedSha256,
        canonical_source_sha256: target.admittedSha256,
        app_message_sha256: sha(target.messageId),
        app_turn_sha256: sha(target.turnId),
        canonical_message_sha256: sha(target.conversationRequestMessageId),
        canonical_turn_sha256: sha(target.conversationTurnId),
      })),
      projection_polls: projectionPolls,
      projection_poll_budget: {
        used: pollBudget.calls,
        max: pollBudget.maxCalls,
        deadline_at: Number.isFinite(pollBudget.deadlineAt)
          ? new Date(pollBudget.deadlineAt).toISOString()
          : null,
      },
      wall_budget_semantics:
        "checked before and after owner operations; does not cancel an in-flight provider call",
      s3_correction: {
        source_sha256: sha(S3),
        query_sha256: sha(S3_QUERY),
        ...correctionTimes,
        supersedes_edges: counts.s3_supersedes,
        exact_graph_binding_sha256: {
          old_claim: sha(correctionBinding.old_claim_id),
          new_claim: sha(correctionBinding.new_claim_id),
          old_likes_edge: sha(correctionBinding.old_likes_edge_id),
          new_likes_edge: sha(correctionBinding.new_likes_edge_id),
          supersedes_edge: sha(correctionBinding.supersedes_edge_id),
          subject: sha(correctionBinding.subject_node_id),
          old_object: sha(correctionBinding.old_object_node_id),
          new_object: sha(correctionBinding.new_object_node_id),
        },
        current_result: privacySafeRecallTrace(toolTrace.s3Current),
        past_result: privacySafeRecallTrace(toolTrace.s3Past),
        source_read_sha256: sha(toolTrace.s3Read.text),
      },
      canonical_b_user_sources: bTargets.length,
      b_source_spans: bSourceIds.length,
      extraction_windows: finalWindowCount,
      extra_leaf_budget: pollBudget.maxExtraLeaves ?? 0,
      new_extractor_call_budget: newExtractorCallBudget,
      provider_attempts: attempts.map((attempt) => ({
        window_ref_sha256: sha(attempt.window_ref),
        attempt_count: attempt.attempt_count,
        state: attempt.state,
        error_code: attempt.error_code,
        input_sha256: attempt.input_sha256,
        attempt_kind: attempt.attempt_kind,
        provider_invoked: attempt.provider_invoked === 1,
        invocation_ref_sha256: attempt.invocation_ref
          ? sha(attempt.invocation_ref)
          : null,
        outcome_known: attempt.outcome_known === 1,
        provider_evidence: attempt.provider_evidence_json
          ? JSON.parse(attempt.provider_evidence_json)
          : null,
      })),
      provider_attempt_counts: {
        total: attempts.length,
        provider_invocations: providerInvocationRefs.size,
        new_provider_invocations: newProviderInvocationRefs.size,
        provider_results: attempts.filter(
          (attempt) =>
            attempt.attempt_kind === "provider" &&
            attempt.state === "provider_result",
        ).length,
        apply: attempts.filter((attempt) => attempt.attempt_kind === "apply")
          .length,
        interrupted_unknown: attempts.filter(
          (attempt) => attempt.outcome_known === 0,
        ).length,
        legacy_lower_bound: attempts.filter(
          (attempt) => attempt.attempt_kind === "legacy",
        ).length,
        failed: attempts.filter((attempt) => attempt.state === "failed").length,
        schema_retry: attempts.filter((attempt) =>
          attempt.error_code?.startsWith("memory_extract_invalid_"),
        ).length,
        quote_retry: attempts.filter(
          (attempt) => attempt.error_code === "memory_extract_invalid_quote",
        ).length,
      },
      configured_extractor: extractorModel,
      reasoning_effort: extractorReasoning,
      provider_evidence: evidence,
      fixed_query_sha256: sha(FIXED_B_CUE),
      comparison_as_of: comparison.asOf,
      comparison_preconditions: comparison.trace,
      graph_counts: counts,
      graph_recall_status: toolTrace.graphRecall.status,
      hybrid_recall_status: toolTrace.hybridRecall.status,
      vector_coverage: toolTrace.hybridRecall.coverage.vectors.state,
      ranking_metrics: toolTrace.rankingMetrics,
      graph_native_result: privacySafeRecallTrace(toolTrace.graphRecall),
      hybrid_native_result: privacySafeRecallTrace(toolTrace.hybridRecall),
      stored_graph_paths: {
        graph: storedPathTrace(
          graphPath,
          toolTrace.graphPreference.association_path,
        ),
        hybrid: storedPathTrace(
          graphPath,
          toolTrace.hybridPreference.association_path,
        ),
      },
      claim_seed_typed_path: {
        relation: claimPath.relation,
        traversed_reverse: claimPath.traversed_reverse,
      },
      read_args_sha256: sha(JSON.stringify(toolTrace.returnedReadArgs)),
      source_ref_sha256: sha(toolTrace.read.source_ref),
      source_hash: toolTrace.read.source_hash,
      source_bytes: Buffer.byteLength(toolTrace.read.text, "utf8"),
      linkage_sha256: {
        source: sha(linkage.source_id),
        episode: sha(linkage.episode_id),
        revision: sha(linkage.revision),
        job: sha(linkage.job_id),
        window: sha(linkage.window_ref),
        app_session: sha(linkage.conversation_session_id),
        btcc_turn: sha(linkage.conversation_turn_id),
        canonical_outcome: sha(outcomeId),
        completion_jobs: sha(linkage.observed_completion_job_ids),
        normalized_plan: sha(linkage.normalized_plan_json),
      },
      model_round_calls: modelCalls,
      model_round_driver: "deterministic",
      extractor_execution: "configured_provider_preserving_live03_successes",
      executor_readiness_precondition: "existing_native_marker",
      raw_personal_text_included: false,
    };
    const tracePath = `${butlerData}/memory-t2-live-trace.json`;
    writeFileSync(tracePath, `${JSON.stringify(trace, null, 2)}\n`);
    return {
      ...trace,
      trace_path: tracePath,
      trace_sha256: sha(readFileSync(tracePath, "utf8")),
    };
  } finally {
    t4Observer?.stop();
    await composition.host.close();
    app.stop();
    bindings.close();
  }
}

type T4AppAdmission = {
  chatId: string;
  model: string;
  reasoningEffort: "medium";
  awaitT4FinalSynthesis?: boolean;
};
type T4PreservedPins = {
  jobs: Array<Record<string, unknown>>;
  sources: Array<Record<string, unknown>>;
  windows: Array<Record<string, unknown>>;
  completed: Array<Record<string, unknown>>;
  attempts: Array<Record<string, unknown>>;
};
type T4ClosedBaseline = T4PreservedPins & {
  schema: "butler.memory.t4-final-checkpoint.v1";
  butler_data: string;
  generation_id: string;
  general_session_id: string;
  date_kst: string;
  last_week_from: string;
  last_week_to: string;
  this_week_from: string;
  eligible_sources: Array<{
    conversation_session_id: string;
    conversation_message_id: string;
    conversation_turn_id: string | null;
    role: "user" | "assistant";
    created_at: string;
    content_sha256: string;
    content_bytes: number;
  }>;
  resume: {
    ad1: DeliveredTarget;
    ad1_job_id: string;
    ad1_window_ref: string;
    preserved_observation: Record<string, unknown>;
    preserved_failure: Record<string, unknown>;
    preserved_queue: {
      pending: Array<Record<string, any>>;
      processing_count: number;
    };
  };
};
type T4Q1Resume = {
  reviewPath: string;
  reviewSha256: string;
  tracePath: string;
  traceSha256: string;
  observationPath: string;
  observationSha256: string;
  stageEvidenceRoot: string;
  implementationCommit: string;
  trace: Record<string, any>;
  observation: Record<string, any>;
};
const T4_AD1 = "오늘 잠실에서 도자기 수업을 들었어요. 처음 만든 찻잔에 노란 유약을 칠했는데 마음에 들었어요.";
const T4_Q1 = "한국 시간 기준으로 지난주 월요일부터 일요일까지, 프로젝트 얘기 말고 기억에 남는 일상 대화들을 찾아 주세요. 지난주 기록이 없다면 그 사실을 밝혀 주시고, 대신 이번 주 월요일부터 지금까지의 일상 대화들을 찾아 주세요. 서로 다른 대화에서 나온 내용을 날짜와 함께 정리하고, 근거가 되는 원문도 확인해 주세요.";

function t4Json(value: unknown): string {
  const ordered = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(ordered);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, ordered(child)]));
    }
    return item;
  };
  return JSON.stringify(ordered(value));
}

function readT4PreservedPins(graphPath: string): T4PreservedPins {
  const db = new Database(graphPath, { readonly: true });
  try {
    return {
      jobs: db.query<Record<string, unknown>, []>(`
        SELECT job_id,episode_id,revision,extraction_version,generation,extraction_model,
          reasoning_effort,observed_completion_job_ids,
          source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,
          hot_cache_state,next_stage,identity_decisions_json
        FROM memory_projection_jobs ORDER BY job_id
      `).all(),
      sources: db.query<Record<string, unknown>, []>(`
        SELECT source_id,episode_id,revision,source_kind,conversation_session_id,
          conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,
          content_hash,role,origin_kind,observed_at,basis
        FROM memory_chunk_sources ORDER BY source_id
      `).all(),
      windows: db.query<Record<string, unknown>, []>(`
        SELECT window_ref,job_id,state,attempt_count,input_json,normalized_plan_json,
          provider_evidence_json,output_json,recovery_revision
        FROM memory_projection_windows ORDER BY window_ref
      `).all(),
      completed: db.query<Record<string, unknown>, []>(`
        SELECT window_ref, job_id, input_json, normalized_plan_json,
          provider_evidence_json, output_json, attempt_count, recovery_revision
        FROM memory_projection_windows WHERE state='complete' ORDER BY window_ref
      `).all(),
      attempts: db.query<Record<string, unknown>, []>(`
        SELECT attempt_ref,window_ref,job_id,attempt_count,attempt_kind,
          provider_invoked,outcome_known,invocation_ref,state,error_code,input_sha256,
          recorded_at,output_json,provider_evidence_json,recovery_revision,recovery_request_json
        FROM memory_projection_attempts ORDER BY attempt_ref
      `).all(),
    };
  } finally { db.close(); }
}

function t4KstWeek(now: number) {
  const shifted = new Date(now + 9 * 60 * 60 * 1000);
  const day = shifted.toISOString().slice(0, 10);
  const monday = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(),
    shifted.getUTCDate() - (shifted.getUTCDay() + 6) % 7) - 9 * 60 * 60 * 1000;
  return {
    date_kst: day,
    last_week_from: new Date(monday - 7 * 24 * 60 * 60 * 1000).toISOString(),
    last_week_to: new Date(monday).toISOString(),
    this_week_from: new Date(monday).toISOString(),
  };
}

function readT4EligibleSources(root: string): T4ClosedBaseline["eligible_sources"] {
  const reader = createLazyConversationProjectionReader({ butlerData: root });
  try {
    const messages = reader.withPublicSourceSnapshot((snapshot) => {
      const output = [] as ReturnType<typeof snapshot.readMessagePage>;
      let after: { created_at: string; id: string } | null = null;
      while (true) {
        const page = snapshot.readMessagePage({ currentSessionId: "", currentProjectId: null,
          scope: "all_user_sessions", sessionIds: [], projectIds: [], projectFilter: "unassigned",
          includeInternal: false, speaker: "any", eventKind: "any", order: "earliest" }, after, 1_000);
        output.push(...page);
        const tail = page.at(-1);
        if (!tail || page.length < 1_000) break;
        after = { created_at: tail.created_at, id: tail.id };
      }
      return output;
    });
    if (!messages) throw new Error("T4 canonical public source owner is unavailable");
    return messages.map((message) => {
      const text = toContextMessage(message, false).text;
      return { conversation_session_id: message.session_id, conversation_message_id: message.id,
        conversation_turn_id: message.turn_id, role: message.role as "user" | "assistant",
        created_at: message.created_at, content_sha256: sha(text), content_bytes: Buffer.byteLength(text) };
    });
  } finally { reader.close(); }
}

export function prepareT4FinalCheckpoint(rootInput: string, outputPath: string) {
  const root = resolve(rootInput);
  const descriptor = JSON.parse(readFileSync(join(root, "cognition/memory/active-generation.json"), "utf8")) as {
    schema?: string; generation_id?: string;
  };
  if (descriptor.schema !== "butler.memory-active-generation.v2" || !descriptor.generation_id) {
    throw new Error("T4 checkpoint requires the active generation");
  }
  const graphPath = join(root, "cognition/memory/generations", descriptor.generation_id, "graph.sqlite");
  const pins = readT4PreservedPins(graphPath);
  const sessions = new Set(pins.sources.filter((row) =>
    [sha(S1), sha(S2), sha(S3)].includes(String(row.content_hash)))
    .map((row) => String(row.conversation_session_id ?? "")).filter(Boolean));
  if (sessions.size !== 1 || pins.sources.filter((row) => sessions.has(String(row.conversation_session_id)) &&
    [sha(S1), sha(S2), sha(S3)].includes(String(row.content_hash))).length < 3) {
    throw new Error("T4 checkpoint could not bind the original S1/S2/S3 canonical session");
  }
  const week = t4KstWeek(Date.now());
  const checkpoint: Omit<T4ClosedBaseline, "resume"> = {
    schema: "butler.memory.t4-final-checkpoint.v1",
    butler_data: root,
    generation_id: descriptor.generation_id,
    general_session_id: [...sessions][0]!,
    ...week,
    ...pins,
    eligible_sources: readT4EligibleSources(root),
  };
  mkdirSync(dirname(resolve(outputPath)), { recursive: true, mode: 0o700 });
  writeFileSync(resolve(outputPath), JSON.stringify(checkpoint, null, 2), { mode: 0o600 });
  return { status: "prepared", checkpoint_path: resolve(outputPath), checkpoint_sha256: sha(readFileSync(resolve(outputPath), "utf8")),
    generation_id: descriptor.generation_id, eligible_sources: checkpoint.eligible_sources.length };
}

function readT4ClosedBaseline(path: string, root: string, generation: string, graphPath: string): T4ClosedBaseline {
  const baseline = JSON.parse(readFileSync(path, "utf8")) as Omit<T4ClosedBaseline, "resume">;
  if (baseline.schema !== "butler.memory.t4-final-checkpoint.v1" ||
    resolve(baseline.butler_data) !== root || baseline.generation_id !== generation ||
    !baseline.general_session_id || !Array.isArray(baseline.jobs) ||
    !Array.isArray(baseline.sources) || !Array.isArray(baseline.windows) ||
    !Array.isArray(baseline.completed) || !Array.isArray(baseline.attempts) ||
    !Array.isArray(baseline.eligible_sources) || baseline.eligible_sources.length === 0) {
    throw new Error("T4 resume requires the frozen final checkpoint inventory");
  }
  const week = t4KstWeek(Date.now());
  for (const key of ["date_kst", "last_week_from", "last_week_to", "this_week_from"] as const) {
    if (baseline[key] !== week[key]) throw new Error("T4 date binding must be fixed before new ingress");
  }
  const pins = readT4PreservedPins(graphPath);
  if (t4Json(pins) !== t4Json({ jobs: baseline.jobs, sources: baseline.sources,
    windows: baseline.windows, completed: baseline.completed, attempts: baseline.attempts })) {
    throw new Error("T4 frozen projection checkpoint changed before ingress");
  }
  if (t4Json(readT4EligibleSources(root)) !== t4Json(baseline.eligible_sources)) {
    throw new Error("T4 frozen eligible canonical source inventory changed before ingress");
  }
  const initialTrace = JSON.parse(readFileSync(join(root, "memory-t4-actual-phase-trace.json"), "utf8")) as any;
  const trace = JSON.parse(readFileSync(join(root, "memory-t4-resume-trace.json"), "utf8")) as any;
  const observation = JSON.parse(readFileSync(join(root, "memory-t4-resume-observation.json"), "utf8")) as any;
  const artifactRoot = dirname(path);
  const failure = JSON.parse(readFileSync(join(artifactRoot, "t4-actual01-failure-preservation.json"), "utf8")) as any;
  const ad1 = initialTrace.ad1 as DeliveredTarget | undefined;
  if (initialTrace.schema !== "butler.memory.t4-actual-phase-trace.v1" || initialTrace.status !== "failed" ||
    trace.schema !== "butler.memory.t4-resume-trace.v1" || trace.status !== "failed" ||
    trace.source_sha256 !== sha(T4_AD1) || trace.question_sha256 !== sha(T4_Q1) ||
    !ad1 || ad1.requestText !== T4_AD1 || ad1.admittedText !== T4_AD1 ||
    ad1.requestSha256 !== sha(T4_AD1) || ad1.admittedSha256 !== sha(T4_AD1) ||
    observation.schema !== "butler.memory.t4-resume-observation.v1" ||
    failure.status !== "failed_preserved_no_retry" ||
    !trace.failure?.includes("turn-89c78082-5641-49a2-b325-81ce2b783efa")) {
    throw new Error("T4 preserved AD1 and failed Q1 evidence changed");
  }
  const btcc = new Database(join(root, "agent-runtime", "btcc.sqlite"), { readonly: true });
  const app = new Database(join(root, "app.sqlite"), { readonly: true });
  try {
    const turns = btcc.query<any, []>(`SELECT turn_id,semantic_state,final_disposition FROM btcc_turns
      WHERE turn_id IN ('turn-89c78082-5641-49a2-b325-81ce2b783efa',
        'steward-turn-f16f815d01219442da1ada295890826a','turn-bc59019f-7a4e-4729-a095-a8ca6728fe53')
      ORDER BY turn_id`).all();
    const relation = btcc.query<any, [string]>(`SELECT relation_id,parent_turn_id FROM btcc_session_relations
      WHERE relation_id=?`).get("relation-b2e563541fa8b72bdbc4766312d9c75342f5201a");
    const outbox = btcc.query<any, [string]>(`SELECT parent_turn_id,status,delivered_at FROM btcc_subsession_outbox
      WHERE relation_id=?`).get("relation-b2e563541fa8b72bdbc4766312d9c75342f5201a");
    const synthesis = app.query<any, [string]>(`SELECT state,safe_error_code,retryable FROM turns WHERE id=?`)
      .get("turn-bc59019f-7a4e-4729-a095-a8ca6728fe53");
    if (turns.length !== 3 || turns.some((row) => row.semantic_state !== "delivered" || row.final_disposition !== "completed") ||
      relation?.parent_turn_id !== "turn-89c78082-5641-49a2-b325-81ce2b783efa" ||
      outbox?.parent_turn_id !== "synthesis-f42576c0aa356b8b581093d669d4d3aa" || outbox.status !== "delivered" ||
      !outbox.delivered_at || synthesis?.state !== "failed" || synthesis.safe_error_code !== "gateway_failed" ||
      synthesis.retryable !== 0) throw new Error("T4 preserved failed Q1 lineage changed");
  } finally {
    app.close();
    btcc.close();
  }
  const graph = new Database(graphPath, { readonly: true });
  try {
    const count = graph.query<{ n: number }, [string, string, string, string]>(`
      SELECT COUNT(DISTINCT s.content_hash) n FROM memory_chunk_sources s
      JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id
      WHERE s.conversation_session_id=? AND c.project_id IS NULL AND s.content_hash IN (?,?,?)
    `).get(baseline.general_session_id, sha(S1), sha(S2), sha(S3))?.n;
    if (count !== 3) throw new Error("T4 preserved general session does not bind S1/S2/S3");
    const ad1Jobs = graph.query<any, [string, string, string]>(`
      SELECT DISTINCT j.job_id,j.source_state,j.semantic_graph_state,j.episode_vectors_state,
        j.node_vectors_state,j.hot_cache_state,j.next_stage,w.window_ref,
        w.state window_state,w.attempt_count
      FROM memory_projection_jobs j
      JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
      JOIN memory_chunk_sources s ON s.episode_id=j.episode_id AND s.revision=j.revision
      JOIN memory_projection_windows w ON w.job_id=j.job_id
      WHERE s.conversation_session_id=? AND s.conversation_message_id=? AND s.content_hash=?
    `).all(ad1.conversationSessionId, ad1.conversationRequestMessageId, sha(T4_AD1));
    if (ad1Jobs.length !== 1 || JSON.parse(ad1Jobs[0].source_state).state !== "complete" ||
      JSON.parse(ad1Jobs[0].semantic_graph_state).state !== "complete" ||
      [ad1Jobs[0].episode_vectors_state, ad1Jobs[0].node_vectors_state, ad1Jobs[0].hot_cache_state]
        .some((state) => JSON.parse(state).state !== "complete")) {
      throw new Error("T4 delivered AD1 checkpoint is not fully projected");
    }
    return Object.assign(baseline, { resume: {
      ad1,
      ad1_job_id: ad1Jobs[0].job_id,
      ad1_window_ref: ad1Jobs[0].window_ref,
      preserved_observation: observation,
      preserved_failure: failure,
      preserved_queue: { pending: readT4PendingInbound(root), processing_count: 0 },
    } }) as T4ClosedBaseline;
  } finally { graph.close(); }
}

function readT4ResumeAfterQ1(
  baselinePath: string,
  reviewPath: string,
  root: string,
  generation: string,
  graphPath: string,
): { baseline: T4ClosedBaseline; q1: T4Q1Resume } {
  const frozen = JSON.parse(readFileSync(baselinePath, "utf8")) as Omit<T4ClosedBaseline, "resume">;
  if (frozen.schema !== "butler.memory.t4-final-checkpoint.v1" || resolve(frozen.butler_data) !== root ||
    frozen.generation_id !== generation || !frozen.general_session_id || !Array.isArray(frozen.jobs) ||
    !Array.isArray(frozen.sources) || !Array.isArray(frozen.windows) || !Array.isArray(frozen.completed) ||
    !Array.isArray(frozen.attempts) || !Array.isArray(frozen.eligible_sources) || !frozen.eligible_sources.length) {
    throw new Error("T4 Q1 remainder requires the current frozen checkpoint");
  }
  const week = t4KstWeek(Date.now());
  for (const key of ["date_kst", "last_week_from", "last_week_to", "this_week_from"] as const) {
    if (frozen[key] !== week[key]) throw new Error("T4 Q1 remainder date binding changed");
  }
  if (t4Json(readT4PreservedPins(graphPath)) !== t4Json({ jobs: frozen.jobs, sources: frozen.sources,
    windows: frozen.windows, completed: frozen.completed, attempts: frozen.attempts }) ||
    t4Json(readT4EligibleSources(root)) !== t4Json(frozen.eligible_sources)) {
    throw new Error("T4 Q1 remainder checkpoint does not match current canonical state");
  }
  if (readT4PendingInbound(root).length) throw new Error("T4 Q1 remainder requires an empty inbound queue");

  const reviewBytes = readFileSync(reviewPath, "utf8");
  const review = JSON.parse(reviewBytes) as any;
  const tracePath = resolve(review.trace_path ?? "");
  const observationPath = resolve(review.observation_path ?? "");
  const stageEvidenceRoot = resolve(review.stage_evidence_root ?? "");
  const traceBytes = readFileSync(tracePath, "utf8");
  const observationBytes = readFileSync(observationPath, "utf8");
  const trace = JSON.parse(traceBytes) as Record<string, any>;
  const observation = JSON.parse(observationBytes) as Record<string, any>;
  if (review.schema !== "butler.memory.phase-semantic-review.v1" || review.scope !== "Q1_only" ||
    review.outcome !== "accepted" || !/^[0-9a-f]{40,64}$/u.test(review.implementation_commit ?? "") ||
    review.trace_sha256 !== createHash("sha256").update(traceBytes).digest("hex") ||
    review.observation_sha256 !== createHash("sha256").update(observationBytes).digest("hex") ||
    trace.schema !== "butler.memory.t4-resume-trace.v1" || trace.status !== "failed" ||
    trace.generation_id !== generation || trace.question_sha256 !== sha(T4_Q1) ||
    observation.schema !== "butler.memory.t4-resume-observation.v1" || !trace.question ||
    !trace.native_journal || !trace.recall_observation || !trace.q1_stage_inventory) {
    throw new Error("T4 accepted Q1 phase evidence is invalid or incomplete");
  }
  for (const item of t4StageEvidenceRefs(trace.q1_stage_inventory as Record<string, any>)) {
    const source = join(stageEvidenceRoot, item.ref);
    if (sha(readFileSync(source, "utf8")) !== item.sha256) throw new Error("T4 accepted Q1 stage evidence changed");
  }
  const question = (trace.question.originalDelivery ?? trace.question) as DeliveredTarget;
  const lineage = t4LineageTurnIds(root, question.turnId);
  const journal = readT4NativeJournal(root, lineage);
  if (t4Json(journal) !== t4Json(trace.native_journal) ||
    t4Json([...lineage].sort()) !== t4Json([...(trace.question_lineage_turns ?? [])].sort())) {
    throw new Error("T4 accepted Q1 persisted native identity changed");
  }
  const ad1 = trace.ad1 as DeliveredTarget;
  if (!ad1 || ad1.requestSha256 !== sha(T4_AD1)) throw new Error("T4 accepted Q1 AD1 provenance is missing");
  const graph = new Database(graphPath, { readonly: true });
  let ad1Job: any;
  try {
    ad1Job = graph.query<any, [string, string, string]>(`SELECT j.job_id,w.window_ref FROM memory_projection_jobs j
      JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
      JOIN memory_chunk_sources s ON s.episode_id=j.episode_id AND s.revision=j.revision
      JOIN memory_projection_windows w ON w.job_id=j.job_id
      WHERE s.conversation_session_id=? AND s.conversation_message_id=? AND s.content_hash=? LIMIT 1`)
      .get(ad1.conversationSessionId, ad1.conversationRequestMessageId, sha(T4_AD1));
  } finally { graph.close(); }
  if (!ad1Job) throw new Error("T4 accepted Q1 AD1 projection lineage is missing");
  const baseline = { ...frozen, resume: { ad1, ad1_job_id: ad1Job.job_id, ad1_window_ref: ad1Job.window_ref,
    preserved_observation: trace.preserved_ad1_observation ?? {},
    preserved_failure: trace.preserved_actual01_failure ?? {},
    preserved_queue: { pending: [], processing_count: 0 } } } as T4ClosedBaseline;
  const verified = verifyT4ObservedRecall({ calls: (observation.q1_calls ?? []).filter((call: any) => call.phase === "Q1"),
    journal, observations: observation.observations ?? [], baseline, ad1, question,
    graphPath, generationId: generation, lineageTurnIds: lineage });
  if (t4Json(verified) !== t4Json(trace.recall_observation)) throw new Error("T4 accepted Q1 verifier facts changed");
  return { baseline, q1: { reviewPath: resolve(reviewPath), reviewSha256: createHash("sha256").update(reviewBytes).digest("hex"),
    tracePath, traceSha256: review.trace_sha256, observationPath, observationSha256: review.observation_sha256,
    stageEvidenceRoot, implementationCommit: review.implementation_commit, trace, observation } };
}

function assertT4OldPins(graphPath: string, baseline: T4ClosedBaseline, allowPendingProgress = false) {
  const current = readT4PreservedPins(graphPath);
  const oldJobs = new Set(baseline.jobs.map((row) => row.job_id));
  const oldSources = new Set(baseline.sources.map((row) => row.source_id));
  const oldAllWindows = new Set(baseline.windows.map((row) => row.window_ref));
  const oldWindows = new Set(baseline.completed.map((row) => row.window_ref));
  const oldAttempts = new Set(baseline.attempts.map((row) => row.attempt_ref));
  const currentJobs = current.jobs.filter((row) => oldJobs.has(row.job_id));
  const currentWindows = current.windows.filter((row) => oldAllWindows.has(row.window_ref));
  const pendingJobIds = new Set(baseline.windows.filter((row) => row.state === "pending").map((row) => row.job_id));
  const immutableJob = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) =>
    !["observed_completion_job_ids", ...(pendingJobIds.has(row.job_id) ? ["source_state", "semantic_graph_state",
      "episode_vectors_state", "node_vectors_state", "hot_cache_state", "next_stage", "identity_decisions_json"] : [])]
      .includes(key)));
  const completionIdsPreserved = baseline.jobs.every((job) => {
    const currentJob = currentJobs.find((row) => row.job_id === job.job_id);
    const oldIds = JSON.parse(String(job.observed_completion_job_ids ?? "[]")) as unknown[];
    const newIds = JSON.parse(String(currentJob?.observed_completion_job_ids ?? "[]")) as unknown[];
    return oldIds.every((id) => newIds.includes(id));
  });
  const jobsPreserved = allowPendingProgress
    ? currentJobs.length === baseline.jobs.length && completionIdsPreserved &&
      t4Json(currentJobs.map(immutableJob)) === t4Json(baseline.jobs.map(immutableJob))
    : t4Json(currentJobs) === t4Json(baseline.jobs);
  const windowsPreserved = allowPendingProgress
    ? baseline.windows.every((window) => {
      const row = currentWindows.find((candidate) => candidate.window_ref === window.window_ref);
      return window.state === "pending"
        ? row?.job_id === window.job_id
        : t4Json(row) === t4Json(window);
    })
    : t4Json(currentWindows) === t4Json(baseline.windows);
  if (!jobsPreserved ||
    t4Json(current.sources.filter((row) => oldSources.has(row.source_id))) !== t4Json(baseline.sources) ||
    !windowsPreserved ||
    t4Json(current.completed.filter((row) => oldWindows.has(row.window_ref))) !== t4Json(baseline.completed) ||
    t4Json(current.attempts.filter((row) => oldAttempts.has(row.attempt_ref))) !== t4Json(baseline.attempts)) {
    throw new Error("T4 changed frozen source, plan, window, or attempt history");
  }
  return { old_jobs: oldJobs.size, old_sources: oldSources.size,
    old_windows: oldAllWindows.size, old_completed: oldWindows.size, old_attempts: oldAttempts.size,
    new_jobs: current.jobs.length - oldJobs.size, new_sources: current.sources.length - oldSources.size,
    new_windows: current.windows.length - oldAllWindows.size,
    new_attempts: current.attempts.length - oldAttempts.size };
}

function readT4PendingInbound(root: string): Array<{ file: string; record: any }> {
  const pending = join(root, "runtime", "inbound-events", "pending");
  if (!existsSync(pending)) return [];
  return readdirSync(pending).filter((file) => file.endsWith(".json")).sort().map((file) => ({
    file,
    record: JSON.parse(readFileSync(join(pending, file), "utf8")),
  }));
}

function readT4HotCacheStates(graphPath: string): Array<Record<string, unknown>> {
  const graph = new Database(graphPath, { readonly: true });
  try {
    return graph.query<Record<string, unknown>, []>(
      "SELECT job_id,hot_cache_state,next_stage,observed_completion_job_ids FROM memory_projection_jobs ORDER BY rowid",
    ).all();
  } finally { graph.close(); }
}

function assertT4ColdArabicPromptOmission(input: {
  observations: Array<Record<string, unknown>>;
  journal: ReturnType<typeof readT4NativeJournal>;
  lineageTurnIds: ReadonlySet<string>;
}) {
  const accepted = input.observations.find((observation) => {
    if (observation.phase !== "ARABIC" || !input.lineageTurnIds.has(String(observation.turn_id))) return false;
    const route = observation.route_context as ModelRoundRequest["routeContext"];
    return !!route && input.journal.rounds.some((row) => row.turn_id === observation.turn_id &&
      row.round_id === observation.round_id && row.route_digest === route.routeDigest &&
      row.candidate_index === route.cursor && row.model_ref === route.modelRef);
  });
  const prompt = JSON.stringify(accepted?.messages ?? []);
  if (!accepted || prompt.includes("## Hot Cache\\n\\n")) {
    throw new Error("T4 cold Arabic accepted provider input still contained the optional cache");
  }
  return { accepted_turn_id: accepted.turn_id, accepted_round_id: accepted.round_id,
    route_digest: (accepted.route_context as ModelRoundRequest["routeContext"])?.routeDigest,
    hot_cache_section_present: false };
}

function readT4InboundRecords(root: string): Array<{ state: string; file: string; record: any }> {
  return ["pending", "processing", "processed", "failed"].flatMap((state) => {
    const path = join(root, "runtime", "inbound-events", state);
    if (!existsSync(path)) return [];
    return readdirSync(path).filter((file) => file.endsWith(".json")).map((file) => ({
      state,
      file,
      record: JSON.parse(readFileSync(join(path, file), "utf8")),
    }));
  });
}

async function drainT4PreservedTerminalReplays(input: {
  root: string;
  baseline: T4ClosedBaseline;
  dispatcher: BtccInboundDispatcher;
  dependencies: Pick<BtccInboundDispatchOptions, "queue" | "server" | "store" | "deliveryGuard">;
  syncProjection: () => Promise<void>;
  budget: IngressPollBudget;
}): Promise<number> {
  const expected = input.baseline.resume.preserved_queue.pending;
  const expectedFiles = new Set(expected.map((item) => String(item.file)));
  let handled = 0;
  while (true) {
    const pending = readT4PendingInbound(input.root);
    if (pending.length === 0) break;
    if (input.budget.calls >= input.budget.maxCalls || Date.now() >= input.budget.deadlineAt) {
      throw new Error("T4 terminal replay drain exceeded its ingress allocation");
    }
    for (const item of pending) {
      const envelope = item.record?.envelope;
      const preserved = expected.find((candidate) => candidate.file === item.file);
      if (!preserved || !expectedFiles.has(item.file) || envelope?.routingHints?.canonicalEventId !== preserved.metadata?.reconciliationOfEventId ||
        envelope?.routingHints?.turnId !== preserved.turn_id || envelope?.routingHints?.sessionId !== preserved.session_id ||
        envelope?.message?.id !== preserved.btcc?.original_message_id) {
        throw new Error("T4 found an unexplained inbound before Q1");
      }
      const btcc = new Database(join(input.root, "agent-runtime", "btcc.sqlite"), { readonly: true });
      const canonical = new Database(join(input.root, "runtime", "conversation-store.sqlite"), { readonly: true });
      try {
        const turn = btcc.query<any, [string]>(`SELECT semantic_state,final_disposition,session_id,
          trigger_key,original_message_id,original_message FROM btcc_turns WHERE turn_id=?`).get(preserved.turn_id);
        const source = canonical.query<any, [string, string]>(`SELECT m.origin_kind,m.status,m.source_gateway,m.source_ref,t.status turn_status,
          o.outcome FROM conversation_messages m JOIN conversation_turns t ON t.id=m.turn_id
          JOIN conversation_turn_outcomes o ON o.turn_id=t.id WHERE t.id=? AND m.source_ref=? AND m.role='user'`).get(
            preserved.turn_id, `app:${preserved.btcc?.original_message_id}`,
          );
        if (!turn || turn.semantic_state !== "delivered" || turn.final_disposition !== "completed" ||
          turn.session_id !== preserved.session_id || turn.trigger_key !== preserved.metadata?.reconciliationOfEventId ||
          turn.original_message_id !== preserved.btcc?.original_message_id || turn.original_message !== envelope.message.text ||
          !source || source.origin_kind !== "user_input" || source.status !== "complete" ||
          source.source_gateway !== "app" || source.turn_status !== "complete" || source.outcome !== "delivered") {
          throw new Error("T4 terminal replay identity is not durably complete");
        }
      } finally {
        canonical.close();
        btcc.close();
      }
    }
    input.budget.calls += 1;
    const summary = input.dispatcher.poll({ ...input.dependencies, limit: 1 });
    if (summary.claimed > 0) await input.dispatcher.waitForIdle();
    await input.syncProjection();
    if (summary.failed > 0 || summary.interrupted > 0 || summary.claimed !== 1 || summary.handled !== 1) {
      throw new Error(`T4 terminal replay failed: ${JSON.stringify(summary)}`);
    }
    handled += summary.handled;
  }
  const processing = join(input.root, "runtime", "inbound-events", "processing");
  if ((existsSync(processing) ? readdirSync(processing).filter((file) => file.endsWith(".json")).length : 0) !== 0 ||
    handled !== expected.length) {
    throw new Error("T4 terminal replay did not settle the exact preserved inputs");
  }
  return handled;
}

function assertT4PendingLineage(root: string, originalTurnId: string): void {
  const lineage = t4LineageTurnIds(root, originalTurnId);
  for (const item of readT4PendingInbound(root)) {
    const turnId = item.record?.envelope?.routingHints?.turnId;
    if (!turnId || !lineage.has(turnId)) {
      throw new Error("T4 found an inbound outside the exact Q1 relation lineage");
    }
  }
}

type T4PhaseKind = "AD1" | "Q1" | "ARABIC" | "SUPPLEMENT";
type T4ObservedDelivery = {
  operation_call_id: string;
  output: any;
  round: string;
  ordinal: number;
  bytes: number;
};
type T4ObservedCall = {
  phase: "Q1" | "ARABIC";
  turn_id: string;
  id: string;
  name: string;
  args: Record<string, unknown>;
  deliveries: T4ObservedDelivery[];
  output?: any;
  operation_call_id?: string;
  delivered_round?: string;
  selected_ordinal: number;
  delivered_ordinal?: number;
  delivered_bytes?: number;
};

function t4LineageTurnIds(root: string, originalTurnId: string): Set<string> {
  const btcc = new Database(`${root}/agent-runtime/btcc.sqlite`, { readonly: true });
  const app = new Database(`${root}/app.sqlite`, { readonly: true });
  try {
    const relations = btcc.query<any, []>(`
      SELECT r.relation_id,r.parent_session_id,r.parent_turn_id,r.child_session_id,
        d.child_turn_id,d.dispatch_intent_json
      FROM btcc_session_relations r JOIN btcc_subsession_delegations d ON d.relation_id=r.relation_id
      ORDER BY r.ordinal
    `).all();
    const results = btcc.query<any, []>(
      "SELECT relation_id,result_id,child_turn_id,status FROM btcc_steward_results",
    ).all();
    const appTurns = app.query<{ id: string; execution_controls_json: string | null }, []>(
      "SELECT id,execution_controls_json FROM turns WHERE execution_controls_json IS NOT NULL",
    ).all();
    const turns = new Set([originalTurnId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const relation of relations) {
        if (!turns.has(relation.parent_turn_id)) continue;
        const intent = JSON.parse(relation.dispatch_intent_json ?? "null");
        const childEnvelope = intent?.envelope;
        const validChild = intent?.childBinding?.sessionId === relation.child_session_id &&
          childEnvelope?.routingHints?.turnId === relation.child_turn_id &&
          childEnvelope?.peer?.id === relation.child_session_id &&
          childEnvelope?.peer?.parentId === relation.parent_session_id &&
          childEnvelope?.nativeStewardContext?.version === 1 &&
          typeof childEnvelope?.eventId === "string" && typeof childEnvelope?.message?.id === "string";
        if (!validChild) throw new Error("T4 relation lost its stored child dispatch identity");
        if (!turns.has(relation.child_turn_id)) {
          turns.add(relation.child_turn_id);
          changed = true;
        }
        const result = results.find((item) => item.relation_id === relation.relation_id);
        if (result?.child_turn_id && !turns.has(result.child_turn_id)) {
          turns.add(result.child_turn_id);
          changed = true;
        }
        if (result?.result_id) {
          const workerInput = readT4InboundRecords(root).find((item) =>
            item.record?.envelope?.eventId === `worker-result:${result.result_id}`
          );
          const workerEnvelope = workerInput?.record?.envelope;
          if (workerEnvelope) {
            const workerTurnId = workerEnvelope.routingHints?.turnId;
            if (!workerTurnId || workerEnvelope.routingHints?.sessionId !== relation.parent_session_id ||
              workerEnvelope.peer?.id !== relation.parent_session_id ||
              workerEnvelope.message?.id !== `worker-result-message:${result.result_id}` ||
              workerEnvelope.nativeStewardContext?.role !== "steward" ||
              workerEnvelope.raw?.source !== "btcc-worker-result") {
              throw new Error("T4 Worker result continuation lost its stored dispatch identity");
            }
            if (!turns.has(workerTurnId)) {
              turns.add(workerTurnId);
              changed = true;
            }
          }
        }
        for (const turn of appTurns) {
          const controls = JSON.parse(turn.execution_controls_json ?? "null");
          const synthesis = controls?.subsession_result;
          if (synthesis?.relation_id === relation.relation_id &&
            synthesis?.result_id === result?.result_id && !turns.has(turn.id)) {
            turns.add(turn.id);
            changed = true;
          }
        }
      }
    }
    return turns;
  } finally {
    app.close();
    btcc.close();
  }
}

function assertT4AdmittedModelRoute(root: string, request: ModelRoundRequest): void {
  const turnId = request.usageAttribution?.turnId;
  if (!turnId) throw new Error("T4 model request has no admitted turn identity");
  const db = new Database(`${root}/agent-runtime/btcc.sqlite`, { readonly: true });
  try {
    const row = db.query<{ model_selection_json: string; route_state_json: string | null }, [string]>(
      "SELECT model_selection_json,route_state_json FROM btcc_turns WHERE turn_id=?",
    ).get(turnId);
    const selection = row ? JSON.parse(row.model_selection_json) : null;
    const route = row?.route_state_json ? JSON.parse(row.route_state_json) : null;
    const candidate = route?.candidates?.[route.activeCursor];
    const primary = route?.candidates?.[0];
    if (!row || !selection || !route ||
      primary?.modelRef !== `${selection.provider}/${selection.model}` ||
      primary?.reasoningEffort !== selection.reasoningEffort ||
      candidate?.modelRef !== request.model ||
      candidate?.reasoningEffort !== request.reasoningEffort ||
      route.routeDigest !== request.routeContext?.routeDigest ||
      route.activeCursor !== request.routeContext?.cursor) {
      throw new Error("T4 provider request changed its persisted model route");
    }
  } finally { db.close(); }
}

function createT4PhaseObserver(delegate: ModelRoundPort, currentTurn: () => string | null,
  deadlineAt: number, root: string, preserved?: Record<string, unknown>, performance?: T4PerformanceOptions) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("T4 phase wall deadline")), Math.max(0, deadlineAt - Date.now()));
  timer.unref();
  let supplementAbort: AbortController | null = null;
  let supplementTimer: ReturnType<typeof setTimeout> | null = null;
  let supplementDeadlineAt: number | null = null;
  const preservedRounds = preserved as any;
  const rounds: Record<T4PhaseKind, Set<string>> = {
    AD1: new Set((preservedRounds?.observations ?? []).filter((item: any) => item.phase === "AD1")
      .map((item: any) => `${item.turn_id}:${item.round_id}`)),
    Q1: new Set(),
    ARABIC: new Set(),
    SUPPLEMENT: new Set(),
  };
  const dispatches = { AD1: Number(preservedRounds?.dispatch_admissions?.AD1 ?? 0), Q1: 0, ARABIC: 0, SUPPLEMENT: 0 };
  const observations: Array<Record<string, unknown>> = JSON.parse(JSON.stringify(
    preservedRounds?.observations ?? [],
  ));
  const q1Calls: T4ObservedCall[] = [];
  const pendingCalls = new Map<string, T4ObservedCall>();
  const seenTools = new Map<string, unknown>();
  let phase: T4PhaseKind | null = null;
  const save = () => writeFileSync(`${root}/memory-t4-resume-observation.json`, JSON.stringify({
    schema: "butler.memory.t4-resume-observation.v1", dispatch_admissions: dispatches,
    logical_rounds: { AD1: rounds.AD1.size, Q1: rounds.Q1.size, ARABIC: rounds.ARABIC.size,
      SUPPLEMENT: rounds.SUPPLEMENT.size }, observations,
    q1_calls: q1Calls, observed_memory_tools: Object.fromEntries(seenTools),
    physical_http_count: null, physical_http_count_reason: "delegate admission is not confirmed HTTP transmission",
  }, null, 2));
  const port: ModelRoundPort = {
    contextSizing: delegate.contextSizing?.bind(delegate),
    initialRequestBytes: delegate.initialRequestBytes?.bind(delegate),
    statelessMessageBytes: delegate.statelessMessageBytes?.bind(delegate),
    async runRound(request) {
      const active = phase;
      const rootTurnId = currentTurn();
      const turnId = request.usageAttribution?.turnId;
      const lineage = rootTurnId ? t4LineageTurnIds(root, rootTurnId) : new Set<string>();
      const activeDeadlineAt = active === "SUPPLEMENT" ? supplementDeadlineAt : deadlineAt;
      const activeAbort = active === "SUPPLEMENT" ? supplementAbort : abort;
      if (!active || !rootTurnId || !turnId || !lineage.has(turnId) || !request.roundId ||
        request.providerRetryAttempts !== 1 || !activeDeadlineAt || !activeAbort ||
        Date.now() >= activeDeadlineAt || activeAbort.signal.aborted) {
        throw new Error("T4 actual provider request escaped its admitted turn/model/time binding");
      }
      if (turnId === rootTurnId &&
        (request.model !== "openai/gpt-5.5" || request.reasoningEffort !== "medium")) {
        throw new Error("T4 public question changed its fixed model selection");
      }
      assertT4AdmittedModelRoute(root, request);
      rounds[active].add(`${turnId}:${request.roundId}`);
      const questionRounds = rounds.Q1.size + rounds.ARABIC.size;
      const questionDispatches = dispatches.Q1 + dispatches.ARABIC;
      const activeRoundLimit = active === "AD1" ? 2 : active === "SUPPLEMENT"
        ? performance?.supplementMaxLogicalRounds ?? 0 : 24;
      const activeDispatchLimit = active === "AD1" ? 6 : active === "SUPPLEMENT"
        ? performance?.supplementMaxDispatches ?? 0 : 72;
      const questionPhase = active === "Q1" || active === "ARABIC";
      if (rounds[active].size > activeRoundLimit || (questionPhase && questionRounds > 24) ||
        dispatches[active] >= activeDispatchLimit || (questionPhase && questionDispatches >= 72)) {
        throw new Error("T4 actual phase exceeded its fixed round/dispatch allocation");
      }
      const deliveries: Array<{ call: T4ObservedCall; delivery: T4ObservedDelivery }> = [];
      if (active === "Q1" || active === "ARABIC") {
        for (const tool of request.tools) {
          if (["recall_memory", "query_memory", "list_conversation_sessions", "read_conversation_session"].includes(tool.name)) {
            seenTools.set(tool.name, tool);
          }
        }
        for (const message of request.messages) {
          if (message.role !== "tool" || !message.toolCallId || !message.operationResultCallId) continue;
          const call = pendingCalls.get(`${turnId}:${message.toolCallId}`);
          if (!call) continue;
          try {
            const parsed = JSON.parse(message.content);
            deliveries.push({ call, delivery: {
              operation_call_id: message.operationResultCallId,
              output: parsed.output ?? parsed, round: request.roundId,
              ordinal: observations.length, bytes: Buffer.byteLength(message.content),
            } });
          } catch { /* Non-JSON/reference carriers remain explicit unproven source reads. */ }
        }
      }
      dispatches[active] += 1;
      const observation: Record<string, unknown> = {
        phase: active, turn_id: turnId, round_id: request.roundId, model: request.model,
        reasoning_effort: request.reasoningEffort, provider_retry_attempts: request.providerRetryAttempts,
        route_transport_attempt: request.routeTransportAttemptOrdinal ?? null,
        route_context: request.routeContext ? { ...request.routeContext } : null,
        started_at: new Date().toISOString(), instructions: request.instructions ?? null,
        messages: JSON.parse(JSON.stringify(request.messages)),
        tools: JSON.parse(JSON.stringify(request.tools)), tool_choice: request.toolChoice ?? null,
      };
      observations.push(observation);
      save();
      try {
        const signal = request.signal ? AbortSignal.any([request.signal, activeAbort.signal]) : activeAbort.signal;
        const result = await delegate.runRound({ ...request, signal });
        observation.finished_at = new Date().toISOString();
        observation.provider_identity = result.providerIdentity ?? null;
        observation.usage = result.usage ?? null;
        observation.text = result.text ?? null;
        observation.tool_calls = JSON.parse(JSON.stringify(result.toolCalls));
        // Delegate success is only a candidate; durable route acceptance is checked after the turn.
        for (const { call, delivery } of deliveries) call.deliveries.push(delivery);
        if (active === "Q1" || active === "ARABIC") {
          for (const call of result.toolCalls) {
            const observed: T4ObservedCall = { phase: active, turn_id: turnId, id: call.id, name: call.name,
              args: JSON.parse(JSON.stringify(call.arguments)), deliveries: [], selected_ordinal: observations.length - 1 };
            q1Calls.push(observed);
            pendingCalls.set(`${turnId}:${call.id}`, observed);
          }
        }
        save();
        return result;
      } catch (error) {
        observation.finished_at = new Date().toISOString();
        observation.failed = true;
        save();
        throw error;
      }
    },
  };
  return { port, observations, q1Calls, seenTools, dispatches, rounds,
    setPerformanceDeadline(value: number) {
      if (supplementAbort || !Number.isFinite(value) || value <= Date.now()) {
        throw new Error("T4 supplement deadline is unavailable");
      }
      supplementDeadlineAt = value;
      supplementAbort = new AbortController();
      supplementTimer = setTimeout(() => supplementAbort?.abort(new Error("T4 supplement wall deadline")),
        Math.max(0, supplementDeadlineAt - Date.now()));
      supplementTimer.unref();
    },
    begin(kind: T4PhaseKind) {
      if (kind === "SUPPLEMENT" && (!supplementAbort || !supplementDeadlineAt)) {
        throw new Error("T4 supplement phase has no performance deadline");
      }
      phase = kind;
    }, end() { phase = null; },
    save, stop() { clearTimeout(timer); if (supplementTimer) clearTimeout(supplementTimer); } };
}

async function createT4EmptyChat(url: string) {
  const response = await fetch(`${url}sessions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "chat" }), keepalive: false,
  });
  const envelope = await response.json() as { protocol_version?: string; data?: { session?: { id?: string } } };
  const id = envelope.data?.session?.id;
  if (response.status !== 201 || envelope.protocol_version !== "butler.app.v1" || !id || id === "general") {
    throw new Error("T4 public chat creation did not return a new chat");
  }
  const messages = await fetch(`${url}messages?chat_id=${encodeURIComponent(id)}&cursor=0`).then((item) => item.json()) as any;
  const turns = await fetch(`${url}turns?chat_id=${encodeURIComponent(id)}`).then((item) => item.json()) as any;
  if (!Array.isArray(messages.data?.messages) || messages.data.messages.length !== 0 ||
    !Array.isArray(turns.data?.turns) || turns.data.turns.length !== 0) {
    throw new Error("T4 new public chat was not empty before its first message");
  }
  return id;
}

function readT4NativeJournal(root: string, turnIds: ReadonlySet<string> | readonly string[]) {
  const selected = turnIds instanceof Set ? turnIds : new Set(turnIds);
  const db = new Database(`${root}/agent-runtime/btcc.sqlite`, { readonly: true });
  try {
    return {
      calls: db.query<{
        turn_id: string;
        call_id: string; tool_name: string; arguments_json: string; result_json: string | null;
        status: string; delivery_state: string | null; delivery_round_id: string | null;
        delivery_response_sha256: string | null;
      }, []>(`SELECT turn_id,call_id,tool_name,arguments_json,result_json,status,delivery_state,
        delivery_round_id,delivery_response_sha256
        FROM btcc_guided_tool_calls ORDER BY rowid`).all().filter((row) => selected.has(row.turn_id)),
      rounds: db.query<{
        turn_id: string;
        round_id: string; route_digest: string; candidate_index: number;
        model_ref: string; transport_attempt: number; normalized_response_json: string;
      }, []>(`SELECT turn_id,round_id,route_digest,candidate_index,model_ref,transport_attempt,normalized_response_json
        FROM btcc_model_round_acceptances ORDER BY rowid`).all().filter((row) => selected.has(row.turn_id)),
    };
  } finally { db.close(); }
}

function t4NativeOutputMatches(name: string, delivered: any, stored: any): boolean {
  if (!delivered || !stored) return false;
  const structural = (fields: string[]) => fields.every((field) =>
    Object.hasOwn(stored, field) && Object.hasOwn(delivered, field) &&
    t4Json(delivered[field]) === t4Json(stored[field]));
  if (name === "read_conversation_session") {
    if (delivered.mode === "source") {
      const fields = ["ok", "status", "mode", "source_ref", "source_hash", "text", "byte_start", "byte_end",
        "next_cursor", "conversation_session_id", "conversation_message_id", "diagnostics"];
      return structural(fields);
    }
    if (!Array.isArray(delivered.messages) || !Array.isArray(stored.messages) ||
      !structural(["ok", "session_id", "runtime_session_id"]) ||
      (delivered.returned !== undefined && !structural(["returned"])) ||
      (delivered.truncated !== undefined && !structural(["truncated"])) ||
      delivered.session_id !== stored.session_id || delivered.runtime_session_id !== stored.runtime_session_id ||
      delivered.messages.length > stored.messages.length) return false;
    return delivered.messages.every((message: any) => stored.messages.some((original: any) =>
      ["conversation_message_id", "turn_id", "seq", "created_at", "speaker", "role", "text", "parts"]
        .every((field) => t4Json(message[field] ?? null) === t4Json(original[field] ?? null))));
  }
  if (name === "recall_memory") {
    if (!structural(["ok", "status"]) ||
      !Array.isArray(delivered.results) || !Array.isArray(stored.results)) return false;
    if (delivered.results.length === 0) return stored.results.length === 0 &&
      structural(["coverage", "next_cursor", "diagnostics"]);
    return delivered.results.every((result: any) => stored.results.some((original: any) =>
      original.episode_ref === result.episode_ref && original.revision === result.revision &&
      original.conversation_at === result.conversation_at && Array.isArray(result.evidence) &&
      result.evidence.every((evidence: any) => original.evidence?.some((source: any) =>
        ["source_ref", "source_resolved", "conversation_session_id", "conversation_message_id", "read_args"].every(
          (field) => t4Json(source[field] ?? null) === t4Json(evidence[field] ?? null))))));
  }
  if (name === "query_memory") {
    if (!structural(["ok", "status"]) ||
      !Array.isArray(delivered.results) || !Array.isArray(stored.results)) return false;
    if (delivered.results.length === 0) return stored.results.length === 0 &&
      structural(["returned", "total_matches", "count_status", "next_cursor", "diagnostics"]);
    return delivered.results.every((result: any) => stored.results.some((original: any) =>
      ["conversation_session_id", "conversation_message_id", "source_ref", "read_args", "created_at", "speaker", "excerpt", "source"]
        .every((field) => t4Json(result[field] ?? null) === t4Json(original[field] ?? null))));
  }
  if (name === "list_conversation_sessions") {
    if (!structural(["ok", "status", "scope", "current_conversation_session_id"]) ||
      !Array.isArray(delivered.sessions) || !Array.isArray(stored.sessions)) return false;
    if (delivered.sessions.length === 0) return stored.sessions.length === 0 &&
      structural(["returned", "next_cursor", "diagnostics"]);
    return delivered.sessions.every((session: any) => stored.sessions.some((original: any) =>
      ["conversation_session_id", "project_id", "last_eligible_message_at", "message_count", "recent_messages"]
        .every((field) => t4Json(session[field] ?? null) === t4Json(original[field] ?? null))));
  }
  return false;
}

type T4VerifiedSource = {
  session_id: string;
  message_id: string;
  source_ref: string | null;
  source_hash: string;
  bytes: number;
  created_at: string;
  producer: "recall_memory" | "query_memory" | "session_context";
  call_id: string;
  producer_call: T4ObservedCall;
  producer_operation_call_id: string;
  read_pages: T4ObservedCall[];
  scalar_ids: Array<{ part_id: string; pointer: string; text: string; hash: string }>;
  returned_message: Record<string, unknown> | null;
};

function t4CanonicalMessage(root: string, messageId: string) {
  const reader = createLazyConversationProjectionReader({ butlerData: root });
  try {
    const message = reader.readMessageById(messageId);
    if (!message) return null;
    const session = reader.getSession(message.session_id);
    const eligible = reader.withPublicSourceSnapshot((snapshot) => {
      let after: { created_at: string; id: string } | null = null;
      while (true) {
        const page = snapshot.readMessagePage({ currentSessionId: message.session_id, currentProjectId: null,
          scope: "all_user_sessions", sessionIds: [message.session_id], projectIds: [],
          projectFilter: "unassigned", includeInternal: false, speaker: "any", eventKind: "any",
          order: "earliest", time: { from: message.created_at,
            to: new Date(Date.parse(message.created_at) + 1).toISOString() } }, after, 1_000);
        if (page.some((candidate) => candidate.id === message.id)) return true;
        const tail = page.at(-1);
        if (!tail || page.length < 1_000) return false;
        after = { created_at: tail.created_at, id: tail.id };
      }
    }) === true;
    const context = toContextMessage(message, false);
    return { session_id: message.session_id, message_id: message.id, turn_id: message.turn_id,
      role: message.role, project_id: session?.project_id ?? null, created_at: message.created_at,
      conversation_start: session?.created_at ?? message.created_at,
      conversation_end: session?.updated_at ?? message.created_at,
      text: context.text, context,
      scalars: decodeMessageScalars(message).map((scalar) => ({ part_id: scalar.part.id,
        pointer: scalar.pointer, text: scalar.text, hash: scalar.hash })), eligible };
  } finally { reader.close(); }
}

function t4SourceReadArgsMatch(actual: Record<string, unknown>, expected: Record<string, unknown>,
  cursor: string | null): boolean {
  const identityKeys = ["source_ref", "scope", "session_ids", "project_filter", "project_ids", "include_internal"];
  if (identityKeys.some((key) => t4Json(actual[key] ?? null) !== t4Json(expected[key] ?? null))) return false;
  if (t4Json(actual.cursor ?? null) !== t4Json(cursor)) return false;
  const allowed = new Set([...identityKeys, "cursor", "max_chars"]);
  if (Object.keys(actual).some((key) => !allowed.has(key))) return false;
  return actual.max_chars === undefined ||
    Number.isSafeInteger(actual.max_chars) && Number(actual.max_chars) >= 256 && Number(actual.max_chars) <= 16_000;
}

function t4BoundSourceScalar(sourceRef: string, canonical: NonNullable<ReturnType<typeof t4CanonicalMessage>>,
  graph: Database) {
  const handle = sourceRef.split(":");
  if (handle[0] === "conversation-source" && handle[1] === "v2" && handle.length === 6) {
    const messageId = Buffer.from(handle[2]!, "base64url").toString("utf8");
    const partId = Buffer.from(handle[3]!, "base64url").toString("utf8");
    const pointer = Buffer.from(handle[4]!, "base64url").toString("utf8");
    const scalar = canonical.scalars.find((item) => item.part_id === partId && item.pointer === pointer);
    return messageId === canonical.message_id && scalar?.hash === handle[5]
      ? { scalar, generation_id: "canonical-conversation", row: null } : null;
  }
  if (handle[0] !== "memory-source" || handle[1] !== "v2" || handle.length !== 4) return null;
  const generationId = Buffer.from(handle[2]!, "base64url").toString("utf8");
  const sourceId = Buffer.from(handle[3]!, "base64url").toString("utf8");
  const row = graph.query<any, [string]>(`SELECT s.source_id,s.episode_id,s.revision,s.content_hash,
    s.conversation_session_id,s.conversation_message_id,s.part_id,s.scalar_pointer,c.project_id,s.observed_at
    FROM memory_chunk_sources s JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id WHERE s.source_id=?`).get(sourceId);
  const scalar = row && canonical.scalars.find((item) => item.part_id === row.part_id && item.pointer === row.scalar_pointer);
  return row && scalar?.hash === row.content_hash && row.conversation_message_id === canonical.message_id
    ? { scalar, generation_id: generationId, row } : null;
}

function t4ReadFullSource(native: T4ObservedCall[], producer: T4ObservedCall,
  readArgs: Record<string, unknown>, sourceRef: string, sessionId: string, messageId: string) {
  if (readArgs.source_ref !== sourceRef) return null;
  const pieces: string[] = [];
  let cursor: string | null = null;
  let expectedStart = 0;
  let sourceHash: string | null = null;
  let callId = "";
  const pages: T4ObservedCall[] = [];
  for (const read of native) {
    if (read.name !== "read_conversation_session" || read.selected_ordinal < (producer.delivered_ordinal ?? 0) ||
      !t4SourceReadArgsMatch(read.args, readArgs, cursor)) continue;
    const out = read.output;
    if (out?.ok !== true || out.mode !== "source" || out.source_ref !== sourceRef ||
      out.conversation_session_id !== sessionId || out.conversation_message_id !== messageId ||
      out.byte_start !== expectedStart || typeof out.text !== "string" ||
      out.byte_end !== expectedStart + Buffer.byteLength(out.text) ||
      (sourceHash !== null && out.source_hash !== sourceHash)) return null;
    pieces.push(out.text);
    expectedStart = out.byte_end;
    sourceHash = out.source_hash;
    callId = read.id;
    pages.push(read);
    cursor = out.next_cursor ?? null;
    if (!cursor) return out.status === "complete" && sourceHash && sha(pieces.join("")) === sourceHash
      ? { text: pieces.join(""), sourceHash, bytes: expectedStart, callId, pages } : null;
  }
  return null;
}

function verifyT4ObservedRecall(input: {
  calls: T4ObservedCall[]; journal: ReturnType<typeof readT4NativeJournal>;
  observations: Array<Record<string, unknown>>;
  baseline: T4ClosedBaseline; ad1: DeliveredTarget; question: DeliveredTarget;
  graphPath: string; generationId: string; lineageTurnIds: ReadonlySet<string>;
}) {
  const acceptedResponse = (ordinal: number) => {
    const observation = input.observations[ordinal];
    if (!observation || observation.failed || !input.lineageTurnIds.has(String(observation.turn_id)) ||
      !Array.isArray(observation.tool_calls)) return null;
    const route = observation.route_context as ModelRoundRequest["routeContext"];
    if (!route || route.modelRef !== observation.model) return null;
    const accepted = input.journal.rounds.find((row) => row.turn_id === observation.turn_id &&
      row.round_id === observation.round_id &&
      row.route_digest === route.routeDigest && row.candidate_index === route.cursor &&
      row.model_ref === route.modelRef);
    if (!accepted) return null;
    const response = JSON.parse(accepted.normalized_response_json) as ModelRoundResult;
    if ((response.text ?? null) !== observation.text ||
      t4Json(response.toolCalls) !== t4Json(observation.tool_calls)) return null;
    return response;
  };
  const native = input.calls.flatMap((call): T4ObservedCall[] => {
    if (!acceptedResponse(call.selected_ordinal)) return [];
    for (const delivery of call.deliveries) {
      const response = acceptedResponse(delivery.ordinal);
      const row = input.journal.calls.find((item) => item.turn_id === call.turn_id &&
        item.call_id === delivery.operation_call_id);
      if (!response || !row || row.tool_name !== call.name || row.status !== "completed" ||
        !row.result_json || t4Json(JSON.parse(row.arguments_json)) !== t4Json(call.args)) continue;
      // Small results need no replay admission. Admitted results must retain this exact accepted delivery.
      if (row.delivery_state !== null &&
        (!["acknowledged", "reference_only"].includes(row.delivery_state) ||
          row.delivery_round_id !== delivery.round || row.delivery_response_sha256 !== btccDigest(btccStableJson({
            text: response.text ?? "", calls: response.toolCalls.map((item) => ({
              id: item.id, name: item.name, rawArguments: item.rawArguments,
            })),
          })))) continue;
      const stored = JSON.parse(row.result_json);
      if (!t4NativeOutputMatches(call.name, delivery.output, stored.output ?? stored)) continue;
      return [{ ...call, output: delivery.output, operation_call_id: delivery.operation_call_id,
        delivered_round: delivery.round, delivered_ordinal: delivery.ordinal, delivered_bytes: delivery.bytes }];
    }
    return [];
  });
  const questionRow = t4CanonicalMessage(input.baseline.butler_data, input.question.conversationRequestMessageId);
  const questionAt = questionRow ? Date.parse(questionRow.created_at) : Number.NaN;
  if (!questionRow?.eligible || !Number.isFinite(questionAt) || questionRow.text !== T4_Q1) {
    throw new Error("T4 Q1 request did not retain its canonical ingress identity");
  }
  const covers = (call: T4ObservedCall, from: string, to: string) => {
    const time = call.args.time as any;
    return time?.basis === "conversation" && Date.parse(time.from) <= Date.parse(from) &&
      Date.parse(time.to) >= Date.parse(to);
  };
  const eligibleSessions = new Set(input.baseline.eligible_sources.map((source) => source.conversation_session_id));
  const adequateScope = (call: T4ObservedCall) => {
    const selectedSessions = Array.isArray(call.args.session_ids) && call.args.session_ids.length > 0
      ? new Set(call.args.session_ids.filter((id): id is string => typeof id === "string")) : null;
    const projectFilter = String(call.args.project_filter ?? "any");
    const defaultScope = questionRow.project_id ? "current_project" : "all_user_sessions";
    const effectiveScope = call.args.scope ??
      (call.name === "list_conversation_sessions" ? call.output?.scope?.kind : undefined) ?? defaultScope;
    return effectiveScope === "all_user_sessions" &&
      (!selectedSessions || [...eligibleSessions].every((id) => selectedSessions.has(id))) &&
      call.args.include_internal !== true && ["any", "unassigned"].includes(projectFilter) &&
      (!Array.isArray(call.args.project_ids) || call.args.project_ids.length === 0);
  };
  const enumerationPage = (call: T4ObservedCall) => {
    if (!adequateScope(call) || !covers(call, input.baseline.last_week_from, input.baseline.last_week_to)) return false;
    if (call.name === "query_memory") {
      return (call.args.query === undefined || call.args.query === "") &&
        (call.args.match_mode === undefined || call.args.match_mode === "phrase") &&
        (!Array.isArray(call.args.terms) || call.args.terms.length === 0) &&
        (call.args.speaker === undefined || call.args.speaker === "any") &&
        (call.args.event_kind === undefined || call.args.event_kind === "any");
    }
    return call.name === "list_conversation_sessions" &&
      (call.args.session_kind === undefined || call.args.session_kind === "any");
  };
  const completeEnumeration = () => {
    const pages = native.filter(enumerationPage);
    for (const first of pages.filter((call) => call.args.cursor === undefined)) {
      const seen = new Set<string>();
      let page: T4ObservedCall | undefined = first;
      while (page && !seen.has(`${page.turn_id}:${page.id}`)) {
        seen.add(`${page.turn_id}:${page.id}`);
        const rows = page.name === "list_conversation_sessions" ? page.output?.sessions : page.output?.results;
        if (!Array.isArray(rows) || rows.length !== 0) break;
        if (page.output?.status === "complete" && page.output.next_cursor === null) {
          if (page.name === "query_memory" &&
            (page.output.count_status !== "complete" || page.output.total_matches !== 0 || page.output.returned !== 0)) break;
          if (page.name === "list_conversation_sessions" && page.output.returned !== 0) break;
          return page;
        }
        const cursor: unknown = page.output?.next_cursor;
        if (page.output?.status !== "partial" || typeof cursor !== "string" || !cursor) break;
        const delivered: number = page.delivered_ordinal ?? Number.POSITIVE_INFINITY;
        const pageName = page.name;
        page = pages.find((candidate: T4ObservedCall): boolean => !seen.has(`${candidate.turn_id}:${candidate.id}`) &&
          candidate.name === pageName && candidate.selected_ordinal >= delivered && candidate.args.cursor === cursor);
      }
    }
    return null;
  };
  const inventoryLastWeek = input.baseline.eligible_sources.filter((source) =>
    Date.parse(source.created_at) >= Date.parse(input.baseline.last_week_from) &&
    Date.parse(source.created_at) < Date.parse(input.baseline.last_week_to));
  const lastWeek = completeEnumeration();
  if (!lastWeek || inventoryLastWeek.length !== 0) {
    throw new Error("T4 last-week absence lacks a complete adequate search and frozen eligible inventory");
  }

  const verified: T4VerifiedSource[] = [];
  const graph = new Database(input.graphPath, { readonly: true });
  try {
    for (const producer of native) {
      const produced = producer.name === "recall_memory"
        ? (producer.output?.results ?? []).flatMap((result: any) => (result.evidence ?? []).map((evidence: any) => ({
          kind: "recall_memory" as const, result, source_ref: evidence.source_ref,
          session_id: evidence.conversation_session_id, message_id: evidence.conversation_message_id,
          read_args: evidence.read_args, resolved: evidence.source_resolved === true,
        })))
        : producer.name === "query_memory"
          ? (producer.output?.results ?? []).map((result: any) => ({ kind: "query_memory" as const, result,
            source_ref: result.source_ref, session_id: result.conversation_session_id,
            message_id: result.conversation_message_id, read_args: result.read_args, resolved: true }))
          : [];
      for (const source of produced) {
        if (!source.resolved || !source.source_ref || !source.session_id || !source.message_id || !source.read_args) continue;
        const full = t4ReadFullSource(native, producer, source.read_args, source.source_ref, source.session_id, source.message_id);
        const canonical = t4CanonicalMessage(input.baseline.butler_data, source.message_id);
        const bound = canonical ? t4BoundSourceScalar(source.source_ref, canonical, graph) : null;
        const frozen = canonical && input.baseline.eligible_sources.find((item) =>
          item.conversation_session_id === canonical.session_id && item.conversation_message_id === canonical.message_id &&
          item.conversation_turn_id === canonical.turn_id && item.role === canonical.role &&
          item.created_at === canonical.created_at && item.content_sha256 === sha(canonical.text) &&
          item.content_bytes === Buffer.byteLength(canonical.text));
        if (!full || !canonical?.eligible || canonical.session_id !== source.session_id ||
          !frozen || !bound || bound.scalar.text !== full.text || bound.scalar.hash !== full.sourceHash ||
          Date.parse(canonical.created_at) < Date.parse(input.baseline.this_week_from) ||
          Date.parse(canonical.created_at) >= questionAt) continue;
        if (source.kind === "recall_memory") {
          const row = bound.row;
          if (!row || bound.generation_id !== input.generationId || row.project_id !== null ||
            row.episode_id !== source.result.episode_ref || row.revision !== source.result.revision ||
            row.conversation_session_id !== source.session_id) continue;
        }
        verified.push({ session_id: canonical.session_id, message_id: canonical.message_id,
          source_ref: source.source_ref, source_hash: full.sourceHash, bytes: full.bytes,
          created_at: canonical.created_at, producer: source.kind, call_id: full.callId,
          producer_call: producer, producer_operation_call_id: producer.operation_call_id!,
          read_pages: full.pages, scalar_ids: [bound.scalar], returned_message: null });
      }
      if (producer.name === "read_conversation_session" && producer.output?.mode !== "source") {
        for (const message of producer.output?.messages ?? []) {
          const canonical = t4CanonicalMessage(input.baseline.butler_data, message.conversation_message_id);
          const frozen = canonical && input.baseline.eligible_sources.find((item) =>
            item.conversation_session_id === canonical.session_id && item.conversation_message_id === canonical.message_id &&
            item.conversation_turn_id === canonical.turn_id && item.role === canonical.role &&
            item.created_at === canonical.created_at && item.content_sha256 === sha(canonical.text) &&
            item.content_bytes === Buffer.byteLength(canonical.text));
          if (!canonical?.eligible || !frozen || canonical.session_id !== producer.output.session_id ||
            ["conversation_message_id", "turn_id", "seq", "created_at", "speaker", "role", "text", "parts"]
              .some((field) => t4Json(message[field] ?? null) !== t4Json((canonical.context as any)[field] ?? null)) ||
            Date.parse(canonical.created_at) < Date.parse(input.baseline.this_week_from) ||
            Date.parse(canonical.created_at) >= questionAt) continue;
          verified.push({ session_id: canonical.session_id, message_id: canonical.message_id, source_ref: null,
            source_hash: sha(canonical.text), bytes: Buffer.byteLength(canonical.text), created_at: canonical.created_at,
            producer: "session_context", call_id: producer.id, producer_call: producer,
            producer_operation_call_id: producer.operation_call_id!, read_pages: [],
            scalar_ids: canonical.scalars, returned_message: message });
        }
      }
    }
  } finally { graph.close(); }
  const sessions = new Set(verified.map((source) => source.session_id));
  if (sessions.size < 2) {
    throw new Error("T4 did not observe two distinct eligible past sessions through full canonical source reads");
  }
  return { last_week: { call_id: lastWeek.id, producer: lastWeek.name, status: "complete",
    result_count: 0, args: lastWeek.args, inventory_count: 0 }, this_week_sources: verified };
}

function verifyT4ArabicEvidence(input: {
  calls: T4ObservedCall[]; journal: ReturnType<typeof readT4NativeJournal>;
  observations: Array<Record<string, unknown>>; root: string; graphPath: string;
  baseline: T4ClosedBaseline; question: DeliveredTarget; lineageTurnIds: ReadonlySet<string>;
}) {
  const acceptedResponse = (ordinal: number) => {
    const observation = input.observations[ordinal];
    if (!observation || observation.failed || !input.lineageTurnIds.has(String(observation.turn_id))) return null;
    const route = observation.route_context as ModelRoundRequest["routeContext"];
    const accepted = route && input.journal.rounds.find((row) => row.turn_id === observation.turn_id &&
      row.round_id === observation.round_id && row.route_digest === route.routeDigest &&
      row.candidate_index === route.cursor && row.model_ref === route.modelRef);
    if (!accepted) return null;
    const response = JSON.parse(accepted.normalized_response_json) as ModelRoundResult;
    return (response.text ?? null) === observation.text && t4Json(response.toolCalls) === t4Json(observation.tool_calls)
      ? response : null;
  };
  const native = input.calls.flatMap((call): T4ObservedCall[] => {
    if (!acceptedResponse(call.selected_ordinal)) return [];
    for (const delivery of call.deliveries) {
      const response = acceptedResponse(delivery.ordinal);
      const row = input.journal.calls.find((item) => item.turn_id === call.turn_id &&
        item.call_id === delivery.operation_call_id);
      if (!response || !row || row.tool_name !== call.name || row.status !== "completed" || !row.result_json ||
        t4Json(JSON.parse(row.arguments_json)) !== t4Json(call.args)) continue;
      if (row.delivery_state !== null && (!["acknowledged", "reference_only"].includes(row.delivery_state) ||
        row.delivery_round_id !== delivery.round || row.delivery_response_sha256 !== btccDigest(btccStableJson({
          text: response.text ?? "", calls: response.toolCalls.map((item) => ({
            id: item.id, name: item.name, rawArguments: item.rawArguments,
          })),
        })))) continue;
      const stored = JSON.parse(row.result_json);
      if (t4NativeOutputMatches(call.name, delivery.output, stored.output ?? stored)) {
        return [{ ...call, output: delivery.output, operation_call_id: delivery.operation_call_id,
          delivered_round: delivery.round, delivered_ordinal: delivery.ordinal, delivered_bytes: delivery.bytes }];
      }
    }
    return [];
  });
  const question = t4CanonicalMessage(input.root, input.question.conversationRequestMessageId);
  if (!question?.eligible || question.text !== T4_ARABIC_Q) {
    throw new Error("T4 Arabic question did not retain its exact canonical ingress");
  }
  const graph = new Database(input.graphPath, { readonly: true });
  let s3: T4VerifiedSource | undefined;
  try {
    const candidates = native.flatMap((producer) => {
      const rows = producer.name === "recall_memory"
        ? (producer.output?.results ?? []).flatMap((result: any) => result.evidence ?? [])
        : producer.name === "query_memory" ? (producer.output?.results ?? []) : [];
      return rows.map((row: any) => ({ producer, row }));
    });
    for (const { producer, row } of candidates) {
      if (!row.read_args || !row.source_ref || !row.conversation_session_id ||
        !row.conversation_message_id) continue;
      const full = t4ReadFullSource(native, producer, row.read_args, row.source_ref,
        row.conversation_session_id, row.conversation_message_id);
      const canonical = t4CanonicalMessage(input.root, row.conversation_message_id);
      const bound = canonical ? t4BoundSourceScalar(row.source_ref, canonical, graph) : null;
      const frozen = canonical && input.baseline.eligible_sources.some((item) =>
        item.conversation_session_id === canonical.session_id && item.conversation_message_id === canonical.message_id &&
        item.conversation_turn_id === canonical.turn_id && item.role === canonical.role &&
        item.created_at === canonical.created_at && item.content_sha256 === sha(canonical.text) &&
        item.content_bytes === Buffer.byteLength(canonical.text));
      if (full && canonical?.eligible && frozen && bound?.scalar.text === S3 && full.text === S3 &&
        bound.scalar.hash === full.sourceHash && Date.parse(canonical.created_at) < Date.parse(question.created_at)) {
        s3 = { session_id: canonical.session_id, message_id: canonical.message_id,
          source_ref: row.source_ref, source_hash: full.sourceHash, bytes: full.bytes,
          created_at: canonical.created_at, producer: producer.name as "recall_memory" | "query_memory",
          call_id: full.callId, producer_call: producer,
          producer_operation_call_id: producer.operation_call_id!, read_pages: full.pages,
          scalar_ids: [bound.scalar], returned_message: null };
        break;
      }
    }
  } finally { graph.close(); }
  let sessionS3: T4VerifiedSource | undefined;
  for (const call of native.filter((candidate) => candidate.name === "read_conversation_session" && candidate.output?.mode !== "source")) {
    for (const message of call.output?.messages ?? []) {
      const canonical = t4CanonicalMessage(input.root, message.conversation_message_id);
      const frozen = canonical && input.baseline.eligible_sources.some((item) =>
        item.conversation_session_id === canonical.session_id && item.conversation_message_id === canonical.message_id &&
        item.conversation_turn_id === canonical.turn_id && item.role === canonical.role &&
        item.created_at === canonical.created_at && item.content_sha256 === sha(canonical.text) &&
        item.content_bytes === Buffer.byteLength(canonical.text));
      if (canonical?.eligible && frozen && canonical.text === S3 && message.text === S3 &&
        t4Json(message.parts ?? null) === t4Json(canonical.context.parts ?? null) &&
        Date.parse(canonical.created_at) < Date.parse(question.created_at)) {
        sessionS3 = { session_id: canonical.session_id, message_id: canonical.message_id,
          source_ref: null, source_hash: sha(canonical.text), bytes: Buffer.byteLength(canonical.text),
          created_at: canonical.created_at, producer: "session_context", call_id: call.id,
          producer_call: call, producer_operation_call_id: call.operation_call_id!, read_pages: [],
          scalar_ids: canonical.scalars, returned_message: message };
        break;
      }
    }
    if (sessionS3) break;
  }
  if (!s3 && !sessionS3) throw new Error("T4 Arabic answer lacks the full Japanese red-ball correction source");
  return { question_sha256: sha(T4_ARABIC_Q), source_sha256: sha(S3),
    evidence_mode: s3 ? "source" : "session", verified_sources: [s3 ?? sessionS3!],
    semantic_review_required: true };
}

type T4PerformanceBinding = {
  schema: "butler.memory.performance.query-binding.v1";
  status: string;
  verification_generation_id: string;
  source_binding_ref: string;
  source_binding_sha256: string;
  queries: Array<{
    id: string;
    original_question: string;
    bound_native_args: Record<string, unknown>;
    canonical_expected_source_refs: string[][];
  }>;
};

function writeT4Evidence<T>(root: string, name: string, value: T) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
  return { path, ref: name, sha256: sha(readFileSync(path, "utf8")) };
}

function copyT4Evidence(root: string, source: string, ref: string) {
  const destination = join(root, ref);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const bytes = readFileSync(source);
  writeFileSync(destination, bytes, { mode: 0o600 });
  return { path: destination, ref, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function t4StageEvidenceRefs(stage: Record<string, any>): Array<{ ref: string; sha256: string }> {
  return [stage, ...(stage.extractor_attempt_refs ?? []), ...(stage.embedding_receipt_refs ?? [])]
    .filter((item): item is { ref: string; sha256: string } =>
      !!item && typeof item.ref === "string" && typeof item.sha256 === "string");
}

async function writeT4PublicStageInventory(butlerData: string, artifactDir: string, phase: "q1" | "arabic") {
  const [{ canonicalConversationProjectionInventory, memorySourceInventoryHash }, { listTypedMemoryRecordsSnapshot }] = await Promise.all([
    import("../../packages/butler-agent/src/agent/cognition/memory/projection/source.ts"),
    import("../../packages/butler-agent/src/agent/cognition/memory/quality.ts"),
  ]);
  const asOf = new Date().toISOString();
  const canonical = canonicalConversationProjectionInventory({ butlerData, asOf, deadlineAt: Date.now() + 30_000,
    scope: "all_user_sessions", currentSessionId: "", currentProjectId: null,
    sessionIds: [], projectFilter: "any", projectIds: [] });
  const typed = listTypedMemoryRecordsSnapshot(butlerData);
  if (!canonical.available || canonical.partial || typed.length) throw new Error(`T4 ${phase} stage inventory is incomplete`);
  const inventory = { schema: "butler.memory-source-inventory.v1", as_of: asOf,
    origin: { version: "conversation-origin-v1" }, exclusions: canonical.exclusions,
    entries: canonical.entries, typed: [], typed_lifecycle: [], history: [] };
  const file = writeT4Evidence(artifactDir, `stages/${phase}-source-inventory.json`, inventory);
  const descriptor = JSON.parse(readFileSync(join(butlerData, "cognition/memory/active-generation.json"), "utf8"));
  const graph = new Database(join(butlerData, "cognition/memory/generations", descriptor.generation_id, "graph.sqlite"), { readonly: true });
  try {
    const sourceIds = new Set(canonical.entries.flatMap((entry) => entry.sourceIds));
    const jobs = graph.query<any, []>("SELECT * FROM memory_projection_jobs ORDER BY rowid").all().filter((job) =>
      graph.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM memory_chunk_sources WHERE episode_id=?").get(job.episode_id)?.n &&
      graph.query<{ source_id: string }, [string, string]>("SELECT source_id FROM memory_chunk_sources WHERE episode_id=? AND revision=?")
        .all(job.episode_id, job.revision).some((row) => sourceIds.has(row.source_id)));
    const jobIds = new Set(jobs.map((job) => job.job_id));
    const attempts = graph.query<any, []>("SELECT * FROM memory_projection_attempts ORDER BY rowid").all()
      .filter((attempt) => jobIds.has(attempt.job_id));
    const receipts = graph.query<any, []>("SELECT * FROM memory_vector_units WHERE receipt_json IS NOT NULL ORDER BY rowid").all()
      .filter((receipt) => jobIds.has(receipt.job_id));
    const sourceLineage = jobs.map((job) => ({ episode_id: job.episode_id, revision: job.revision,
      source_ids: graph.query<{ source_id: string }, [string, string]>(
        "SELECT source_id FROM memory_chunk_sources WHERE episode_id=? AND revision=? ORDER BY rowid",
      ).all(job.episode_id, job.revision).map((row) => row.source_id), job,
      attempts: attempts.filter((attempt) => attempt.job_id === job.job_id),
      receipts: receipts.filter((receipt) => receipt.job_id === job.job_id) }));
    const attemptFile = writeT4Evidence(artifactDir, `stages/${phase}-extractor-attempts.json`, attempts);
    const receiptFile = writeT4Evidence(artifactDir, `stages/${phase}-embedding-receipts.json`, receipts);
    return { ref: file.ref, sha256: file.sha256, inventory_hash: memorySourceInventoryHash(inventory),
      generation_id: descriptor.generation_id,
      completion_ids: jobs.flatMap((job) => JSON.parse(job.observed_completion_job_ids ?? "[]")),
      projection_job_ids: jobs.map((job) => job.job_id),
      extractor_attempt_refs: attempts.length ? [{ ref: attemptFile.ref, sha256: attemptFile.sha256 }] : [],
      embedding_receipt_refs: receipts.length ? [{ ref: receiptFile.ref, sha256: receiptFile.sha256 }] : [],
      source_lineage: sourceLineage };
  } finally { graph.close(); }
}

function t4PendingLeafWindows(graphPath: string) {
  const db = new Database(graphPath, { readonly: true });
  try {
    return db.query<{ window_ref: string; job_id: string; source_refs_json: string }, []>(`
      SELECT w.window_ref,w.job_id,w.source_refs_json FROM memory_projection_windows w
      WHERE w.state='pending'
        AND NOT EXISTS(SELECT 1 FROM memory_projection_windows child WHERE child.parent_window_ref=w.window_ref)
      ORDER BY w.rowid
    `).all().map((row) => ({ ...row, source_ids: (JSON.parse(row.source_refs_json) as unknown[])
      .filter((ref: unknown): ref is string => typeof ref === "string") }));
  } finally { db.close(); }
}

function t4VectorUnitStates(graphPath: string) {
  const db = new Database(graphPath, { readonly: true });
  try { return db.query<{ unit_id: string; job_id: string; state: string; source_ids_json: string | null;
    projection_text: string; attempt_count: number; owner_pid: number | null; owner_nonce: string | null;
    receipt_json: string | null }, []>(
    `SELECT unit_id,job_id,state,source_ids_json,projection_text,attempt_count,owner_pid,owner_nonce,receipt_json
      FROM memory_vector_units ORDER BY rowid`,
  ).all(); } finally { db.close(); }
}

function t4PendingProjectionCount(graphPath: string): number {
  const db = new Database(graphPath, { readonly: true });
  try {
    const windows = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM memory_projection_windows WHERE state IN ('planned','pending','running')").get()!.n;
    const units = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM memory_vector_units WHERE state IN ('pending','running')").get()!.n;
    const jobs = db.query<any, []>("SELECT semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state FROM memory_projection_jobs").all();
    return windows + units + jobs.filter((job) => [job.semantic_graph_state, job.episode_vectors_state,
      job.node_vectors_state, job.hot_cache_state].some((state) =>
        ["planned", "pending", "running", "partial"].includes(JSON.parse(state).state))).length;
  } finally { db.close(); }
}

function t4SelectedProjectionState(graphPath: string, jobIds?: string[]) {
  const db = new Database(graphPath, { readonly: true });
  try {
    const jobs = jobIds
      ? jobIds.map((jobId) => db.query<any, [string]>(`SELECT job_id,source_state,semantic_graph_state,
          episode_vectors_state,node_vectors_state,hot_cache_state FROM memory_projection_jobs WHERE job_id=?`).get(jobId))
      : db.query<any, []>(`SELECT job_id,source_state,semantic_graph_state,
          episode_vectors_state,node_vectors_state,hot_cache_state FROM memory_projection_jobs ORDER BY rowid`).all();
    if (jobs.some((job) => !job)) throw new Error("T4 selected projection job disappeared");
    const stages = jobs.flatMap((job) => ["source_state", "semantic_graph_state", "episode_vectors_state", "node_vectors_state", "hot_cache_state"]
      .map((key) => ({ job_id: job.job_id, stage: key, ...JSON.parse(job[key]) })));
    const failed = stages.filter((stage) => stage.state === "failed");
    const active = stages.filter((stage) => ["planned", "pending", "running", "partial"].includes(stage.state));
    const notConfigured = stages.filter((stage) => stage.state === "not_configured");
    const invalid = stages.filter((stage) => !["complete", "unsupported", "not_configured", "planned", "pending", "running", "partial", "failed"].includes(stage.state));
    return { stages, failed, active, notConfigured, invalid };
  } finally { db.close(); }
}

function readT4PerformanceBinding(path: string, generationId: string): T4PerformanceBinding {
  const bytes = readFileSync(path);
  if (sha(bytes.toString("utf8")) !== T4_PERFORMANCE_QUERY_BINDING_SHA) throw new Error("T4 fixed query binding changed");
  const value = JSON.parse(bytes.toString("utf8")) as T4PerformanceBinding;
  const sourcePath = resolve(dirname(path), value.source_binding_ref);
  if (value.schema !== "butler.memory.performance.query-binding.v1" ||
    value.verification_generation_id !== generationId || value.source_binding_sha256 !== T4_PERFORMANCE_SOURCE_BINDING_SHA ||
    sha(readFileSync(sourcePath, "utf8")) !== T4_PERFORMANCE_SOURCE_BINDING_SHA || value.queries.length !== 12 ||
    value.queries.some((query, index) => query.id !== `Q${String(index + 1).padStart(2, "0")}` ||
      !query.original_question || !Array.isArray(query.canonical_expected_source_refs) ||
      query.canonical_expected_source_refs.some((group) => !Array.isArray(group) || group.length === 0))) {
    throw new Error("T4 fixed query/source binding is invalid");
  }
  return value;
}

function t4ObservedSourceHandles(result: any): string[] {
  const handles: unknown[] = (Array.isArray(result?.results) ? result.results : []).flatMap((item: any) =>
    Array.isArray(item?.evidence) ? item.evidence.map((evidence: any) => evidence?.source_ref) : []);
  return [...new Set(handles.filter((value: unknown): value is string =>
    typeof value === "string" && value.startsWith("memory-source:v2:")))];
}

function t4ObservedPublicSourceHandles(result: any): string[] {
  const direct = Array.isArray(result?.results) ? result.results : [];
  const handles: unknown[] = direct.flatMap((item: any) => [item?.source_ref,
    ...(Array.isArray(item?.evidence) ? item.evidence.map((evidence: any) => evidence?.source_ref) : [])]);
  return [...new Set(handles.filter((value: unknown): value is string => typeof value === "string" &&
      (value.startsWith("memory-source:v2:") || value.startsWith("conversation-source:v2:"))))];
}

function assertT4BoundCoverage(query: T4PerformanceBinding["queries"][number], handles: string[]) {
  if (query.canonical_expected_source_refs.some((group) => !group.some((handle) => handles.includes(handle)))) {
    throw new Error(`T4 ${query.id} did not return every frozen expected source group`);
  }
}

async function writeT4PerformanceSourceEvidence(input: { butlerData: string; graphPath: string; generationId: string;
  artifactDir: string; resultId: string; handle: string; currentness: "current" | "as_of"; inventoryHash: string;
  nativeRead?: { text: string; ref: string; sha256: string } }) {
  const sourceId = Buffer.from(input.handle.split(":")[3] ?? "", "base64url").toString("utf8");
  const { resolveMemorySource } = await import(
    "../../packages/butler-agent/src/agent/cognition/memory/projection/ingestion.ts"
  );
  const resolved = resolveMemorySource({ context: { butlerData: input.butlerData,
    target: { kind: "active", expected_generation: input.generationId }, signal: new AbortController().signal },
    sourceRef: input.handle });
  const db = new Database(input.graphPath, { readonly: true });
  try {
    const row = db.query<any, [string]>(`SELECT s.source_id,s.episode_id,s.revision,s.content_hash,
      s.conversation_session_id,s.conversation_message_id,s.part_id,s.scalar_pointer,s.byte_start,s.byte_end,
      s.observed_at,c.conversation_start,c.conversation_end,c.project_id
      ,c.current_revision chunk_current_revision,c.status chunk_status
      FROM memory_chunk_sources s JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
      WHERE s.source_id=?`).get(sourceId);
    if (!row?.conversation_message_id) throw new Error("T4 performance source handle is not canonical");
    const canonical = t4CanonicalMessage(input.butlerData, row.conversation_message_id);
    const scalar = canonical?.scalars.find((item) => item.part_id === row.part_id && item.pointer === row.scalar_pointer);
    if (!canonical?.eligible || !scalar || scalar.hash !== row.content_hash || row.byte_start < 0 ||
      row.byte_start >= row.byte_end || row.byte_end > Buffer.byteLength(scalar.text) ||
      resolved.source_ref !== sourceId || resolved.source_hash !== row.content_hash ||
      resolved.scalar_text !== scalar.text || resolved.text !== Buffer.from(scalar.text).subarray(row.byte_start, row.byte_end).toString() ||
      resolved.byte_start !== row.byte_start || resolved.byte_end !== row.byte_end) {
      throw new Error("T4 performance source scalar changed");
    }
    const splitAncestry = db.query<any, [string]>(`WITH RECURSIVE ancestry(source_id,episode_id,revision,source_kind,
      conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,
      role,origin_kind,observed_at,basis,child_source_ids_json) AS (
        SELECT p.source_id,p.episode_id,p.revision,p.source_kind,p.conversation_session_id,p.conversation_message_id,
          p.part_id,p.scalar_pointer,p.byte_start,p.byte_end,p.content_hash,p.role,p.origin_kind,p.observed_at,p.basis,p.child_source_ids_json
        FROM memory_source_split_parents p,json_each(p.child_source_ids_json) child WHERE child.value=?
        UNION ALL
        SELECT p.source_id,p.episode_id,p.revision,p.source_kind,p.conversation_session_id,p.conversation_message_id,
          p.part_id,p.scalar_pointer,p.byte_start,p.byte_end,p.content_hash,p.role,p.origin_kind,p.observed_at,p.basis,p.child_source_ids_json
        FROM memory_source_split_parents p JOIN ancestry child
          ON EXISTS(SELECT 1 FROM json_each(p.child_source_ids_json) item WHERE item.value=child.source_id)
      ) SELECT * FROM ancestry ORDER BY byte_start,byte_end,source_id`).all(sourceId).map((parent) => ({
        source_id: parent.source_id, episode_id: parent.episode_id, revision: parent.revision,
        content_hash: parent.content_hash, conversation_session_id: parent.conversation_session_id,
        conversation_message_id: parent.conversation_message_id, part_id: parent.part_id,
        scalar_pointer: parent.scalar_pointer, byte_start: parent.byte_start, byte_end: parent.byte_end,
        child_source_ids: JSON.parse(parent.child_source_ids_json),
      }));
    const read: MemorySourceReadEvidence & { native_read_ref?: string; native_read_sha256?: string } = {
      schema: "butler.memory-source-read-evidence.v1", result_id: input.resultId,
      observation_kind: "source_ref", source_ref: input.handle, message_id: null,
      canonical: { message_id: row.conversation_message_id, part_id: row.part_id, scalar_pointer: row.scalar_pointer,
        text: scalar.text, bytes: Buffer.byteLength(scalar.text), sha256: scalar.hash, revision: row.revision },
      returned_text: input.nativeRead?.text ?? resolved.scalar_text, source_row: row,
      ...(input.nativeRead ? { native_read_ref: input.nativeRead.ref, native_read_sha256: input.nativeRead.sha256 } : {}) };
    const readFile = writeT4Evidence(input.artifactDir, `reads/${input.resultId}-${sha(input.handle)}.json`, read);
    const binding: MemorySourceBindingEvidence = { schema: "butler.memory-source-binding-evidence.v1", handle: input.handle,
      observation_kind: "source_ref", returned_source_ref: input.handle, returned_message_id: null,
      generation_id: input.generationId, inventory_hash: input.inventoryHash, revision: row.revision,
      source_hash: row.content_hash, observed_at: row.observed_at, currentness: input.currentness,
      returned_in_result_id: input.resultId, read_result_ref: readFile.ref, read_result_sha256: readFile.sha256,
      source_row: row, chunk: { current_revision: row.chunk_current_revision, status: row.chunk_status },
      ...(splitAncestry.length ? { split_ancestry: splitAncestry } : {}),
      canonical: { message_id: row.conversation_message_id, part_id: row.part_id,
        scalar_pointer: row.scalar_pointer, scalar_hash: row.content_hash, revision: row.revision } };
    if (input.nativeRead && input.nativeRead.text !== scalar.text) throw new Error("T4 native source-mode read changed the full scalar");
    return writeT4Evidence(input.artifactDir, `bindings/${input.resultId}-${sha(input.handle)}.json`, binding);
  } finally { db.close(); }
}

async function runT4NativePerformance(input: {
  butlerData: string; graphPath: string; generationId: string; binding: T4PerformanceBinding;
  artifactDir: string; runtime: DeliveredTarget; modes: Array<"graph" | "hybrid">;
  inventoryHash: string;
  repetitions: number[];
  deadlineAt?: number;
  onInterval?: (interval: { query_id: string; started_at: string; ended_at: string }) => void;
  onRawResult?: (ref: { mode: "graph" | "hybrid"; query_id: string; repetition: number; ref: string; sha256: string }) => void;
}): Promise<MemoryRecoveryPerformanceReport["samples"]> {
  const [{ createRecallMemoryToolHandler }, { createReadConversationSessionToolHandler },
    { serializeToolResultPayloadForProvider, createToolResultModelPreviewContext }] = await Promise.all([
    import("../../packages/butler-agent/src/agent/tools/memory/recall_memory/executor.ts"),
    import("../../packages/butler-agent/src/agent/tools/memory/read_conversation_session/executor.ts"),
    import("../../packages/butler-agent/src/agent/tools/tool-result-serialization.ts"),
  ]);
  const handler = createRecallMemoryToolHandler({ butlerHome: process.cwd(), butlerData: input.butlerData,
    sessionId: input.runtime.conversationSessionId, turnId: input.runtime.turnId,
    canonicalUserMessageId: input.runtime.conversationRequestMessageId,
    currentUserMessage: input.runtime.requestText });
  const sourceReader = createReadConversationSessionToolHandler({ butlerHome: process.cwd(), butlerData: input.butlerData,
    sessionId: input.runtime.conversationSessionId, turnId: input.runtime.turnId,
    canonicalUserMessageId: input.runtime.conversationRequestMessageId,
    currentUserMessage: input.runtime.requestText });
  const samples: MemoryRecoveryPerformanceReport["samples"] = [];
  for (const mode of input.modes) for (const query of input.binding.queries) for (const repetition of input.repetitions) {
    const requestId = `t4-performance:${mode}:${query.id}:${repetition}:${crypto.randomUUID()}`;
    const resultId = `t4-result:${crypto.randomUUID()}`;
    const args: Record<string, unknown> = { ...query.bound_native_args, include_vector: mode === "hybrid" };
    const queryHash = sha(t4Json({ id: query.id, args: query.bound_native_args }));
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const callSignals = [AbortSignal.timeout(5_000)];
    if (input.deadlineAt) callSignals.push(AbortSignal.timeout(Math.max(1, input.deadlineAt - Date.now())));
    const output = await handler({ name: "recall_memory", args, rawArguments: JSON.stringify(args),
      providerCallId: requestId, signal: AbortSignal.any(callSignals), toolContractVersion: 2 },
    { effectOccurrenceId: requestId });
    serializeToolResultPayloadForProvider({ ok: true, output }, { toolName: "recall_memory",
      context: createToolResultModelPreviewContext() });
    const elapsed = performance.now() - started;
    input.onInterval?.({ query_id: query.id, started_at: startedAt, ended_at: new Date().toISOString() });
    const nativeStatus = (output as any).status;
    if (elapsed > 5_000 || !["complete", "partial"].includes(nativeStatus)) throw new Error(`T4 ${query.id} ${mode} failed its result/deadline gate`);
    const evidenceStatus: "ok" | "partial" = nativeStatus === "complete" ? "ok" : "partial";
    const rawFile = writeT4Evidence(input.artifactDir, `raw-native/${mode}-${query.id}-${repetition}.json`, {
      request_id: requestId, result_id: resultId, native_status: nativeStatus, output,
    });
    input.onRawResult?.({ mode, query_id: query.id, repetition, ref: rawFile.ref, sha256: rawFile.sha256 });
    const handles = t4ObservedSourceHandles(output);
    assertT4BoundCoverage(query, handles);
    const result: MemoryQueryResultEvidence = { schema: "butler.memory-query-result-evidence.v1", request_id: requestId,
      result_id: resultId, generation_id: input.generationId, query_hash: queryHash,
      status: evidenceStatus, source_handles: handles,
      observations: handles.map((source_ref) => ({ kind: "source_ref" as const, source_ref })) };
    const metrics: MemoryPerformanceMetricsEvidence = { schema: "butler.memory-performance-metrics-evidence.v1",
      mode, query_id: query.id, repetition, result_id: resultId, query_hash: queryHash,
      status: result.status, elapsed_ms: elapsed };
    const resultFile = writeT4Evidence(input.artifactDir, `results/${mode}-${query.id}-${repetition}.json`, result);
    const metricsFile = writeT4Evidence(input.artifactDir, `metrics/${mode}-${query.id}-${repetition}.json`, metrics);
    const evidence = (output as any).results.flatMap((item: any) => item.evidence ?? []);
    const bindingFiles = await Promise.all(handles.map(async (handle) => {
      const readArgs = evidence.find((item: any) => item.source_ref === handle)?.read_args;
      if (!readArgs) throw new Error("T4 native recall omitted source-mode read arguments");
      const pages: any[] = [];
      let cursor: string | undefined;
      let fullText = "";
      let expectedStart = 0;
      let sourceHash: string | null = null;
      do {
        if (!input.deadlineAt || Date.now() >= input.deadlineAt || pages.length >= 256) {
          throw new Error("T4 native source-mode read exceeded its absolute bound");
        }
        const pageArgs = { ...structuredClone(readArgs), ...(cursor ? { cursor } : {}) };
        const nativeRead = await sourceReader({ name: "read_conversation_session", args: pageArgs,
          rawArguments: JSON.stringify(pageArgs), toolContractVersion: 2,
          signal: AbortSignal.timeout(Math.max(1, input.deadlineAt - Date.now())) });
        const page = nativeRead as any;
        if (!page.ok || page.mode !== "source" || page.source_ref !== handle ||
          typeof page.text !== "string" || page.byte_start !== expectedStart ||
          page.byte_end !== expectedStart + Buffer.byteLength(page.text) ||
          (sourceHash !== null && page.source_hash !== sourceHash)) {
          throw new Error("T4 native source-mode read failed");
        }
        pages.push({ args: pageArgs, output: nativeRead });
        fullText += page.text;
        expectedStart = page.byte_end;
        sourceHash = page.source_hash;
        cursor = page.next_cursor ?? undefined;
        if (!cursor && page.status !== "complete") throw new Error("T4 native source-mode read ended before completion");
      } while (cursor);
      const nativeReadFile = writeT4Evidence(input.artifactDir, `native-reads/${resultId}-${sha(handle)}.json`, pages);
      return writeT4PerformanceSourceEvidence({ ...input, resultId, handle,
        currentness: typeof args.as_of === "string" ? "as_of" : "current",
        nativeRead: { text: fullText, ref: nativeReadFile.ref, sha256: nativeReadFile.sha256 } });
    }));
    samples.push({ mode, query_id: query.id, repetition, result_id: resultId, result_ref: resultFile.ref,
      result_sha256: resultFile.sha256, metrics_ref: metricsFile.ref, metrics_sha256: metricsFile.sha256,
      query_hash: queryHash, status: result.status, elapsed_ms: elapsed,
      expected_source_groups: query.canonical_expected_source_refs, observed_source_handles: handles,
      source_binding_refs: bindingFiles.map((file) => ({ ref: file.ref, sha256: file.sha256 })), coverage_ok: true });
  }
  return samples;
}

async function runT4PerformancePhase(input: {
  butlerData: string; graphPath: string; generationId: string; appUrl: string;
  runtime: DeliveredTarget; options: T4PerformanceOptions; observer: ReturnType<typeof createT4PhaseObserver>;
  dispatch: (text: string, admission: T4AppAdmission,
    budgets?: { poll: LivePollBudget; ingress: IngressPollBudget }) => Promise<DeliveredTarget>;
  pollBudget: LivePollBudget; ingressBudget: IngressPollBudget;
}) {
  const budgets = [input.options.supplementMaxLogicalRounds, input.options.supplementMaxDispatches,
    input.options.projectionMaxPollCalls, input.options.performanceMaxWallClockMs];
  if (budgets.some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new Error("T4 performance requires explicit positive budgets");
  const deadlineAt = Date.now() + input.options.performanceMaxWallClockMs;
  const assertBudget = () => { if (Date.now() >= deadlineAt) throw new Error("T4 performance wall budget exceeded"); };
  const dispatchBudgets = {
    poll: { ...input.pollBudget, calls: 0, deadlineAt },
    ingress: { ...input.ingressBudget, calls: 0, deadlineAt },
  };
  input.observer.setPerformanceDeadline(deadlineAt);
  const binding = readT4PerformanceBinding(input.options.queryBindingPath, input.generationId);
  const [{ canonicalConversationProjectionInventory, memorySourceInventoryHash }, { listTypedMemoryRecordsSnapshot }] = await Promise.all([
    import("../../packages/butler-agent/src/agent/cognition/memory/projection/source.ts"),
    import("../../packages/butler-agent/src/agent/cognition/memory/quality.ts"),
  ]);
  const { runServingGenerationCatchup, runCanonicalMemoryCatchup } = await import("../../packages/butler-agent/src/agent/cognition/memory/scripts/phases/catchup.ts");
  const { pollIteration, processEntry } = await import("../../packages/butler-agent/src/agent/cognition/memory/scripts/sync-consumer.ts");
  const { advanceNextMemoryProjection, ingestConversationMemory } = await import(
    "../../packages/butler-agent/src/agent/cognition/memory/projection/ingestion.ts"
  );
  const { readActiveDescriptor } = await import(
    "../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts"
  );
  const deadlineSignal = () => AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()));
  const pollOneQuantum = async () => {
    assertBudget();
    const signal = deadlineSignal();
    return pollIteration({ butlerData: input.butlerData,
      process: (entry) => processEntry(entry, { butlerData: input.butlerData,
        ingest: (request) => ingestConversationMemory({ ...request, context: { ...request.context,
          signal, deadlineAt, waitClass: "background" } }) }),
      advance: ({ context }) => advanceNextMemoryProjection({ context: { ...context, signal,
        deadlineAt, waitClass: "background" } }),
      catchup: async (request) => {
        assertBudget();
        const result = await runCanonicalMemoryCatchup({ ...request, ingest: async (source, observationId) => {
          const descriptor = readActiveDescriptor(input.butlerData);
          await ingestConversationMemory({ context: { butlerData: input.butlerData,
            target: { kind: "active", expected_generation: descriptor.generation_id }, signal,
            deadlineAt, waitClass: "background" }, source, completionJobId: observationId });
        } });
        assertBudget();
        return result;
      },
    });
  };
  await runServingGenerationCatchup({ butlerData: input.butlerData, limit: 256, signal: deadlineSignal() });
  const supplements: DeliveredTarget[] = [];
  for (const item of T4_SUPPLEMENTARY_INPUTS) {
    assertBudget();
    if (t4PendingLeafWindows(input.graphPath).length >= 4) break;
    if (sha(item.text) !== item.sha256) throw new Error("T4 supplementary source bytes changed");
    const chatId = await createT4EmptyChat(input.appUrl);
    input.observer.begin("SUPPLEMENT");
    supplements.push(await input.dispatch(item.text,
      { chatId, model: "openai/gpt-5.5", reasoningEffort: "medium" }, dispatchBudgets));
    input.observer.end();
    await runServingGenerationCatchup({ butlerData: input.butlerData, limit: 256, signal: deadlineSignal() });
  }
  const inventoryAsOf = new Date().toISOString();
  const canonicalInventory = canonicalConversationProjectionInventory({ butlerData: input.butlerData, asOf: inventoryAsOf,
    deadlineAt, scope: "all_user_sessions", currentSessionId: "", currentProjectId: null,
    sessionIds: [], projectFilter: "any", projectIds: [] });
  const typedRecords = listTypedMemoryRecordsSnapshot(input.butlerData);
  if (!canonicalInventory.available || canonicalInventory.partial || typedRecords.length !== 0) {
    throw new Error("T4 qualification inventory requires a complete conversation-only Gtest corpus");
  }
  const qualificationInventory = { schema: "butler.memory-source-inventory.v1", as_of: inventoryAsOf,
    origin: { version: "conversation-origin-v1" }, exclusions: canonicalInventory.exclusions,
    entries: canonicalInventory.entries, typed: [], typed_lifecycle: [], history: [] };
  const inventoryHash = memorySourceInventoryHash(qualificationInventory);
  const inventoryFile = writeT4Evidence(input.options.artifactDir, "qualification-source-inventory.json", qualificationInventory);
  const inventoryDb = new Database(input.graphPath, { readonly: true });
  let currentJobIds: string[];
  try {
    currentJobIds = qualificationInventory.entries.map((entry) => {
      const job = inventoryDb.query<{ job_id: string }, [string, string]>(
        "SELECT job_id FROM memory_projection_jobs WHERE episode_id=? AND revision=?",
      ).get(entry.episodeId, entry.revision);
      if (!job) throw new Error("T4 current qualification source has no projection job");
      return job.job_id;
    });
  } finally { inventoryDb.close(); }
  const selected = t4PendingLeafWindows(input.graphPath).slice(0, 4);
  if (selected.length !== 4) throw new Error("T4 contention requires four actual pending leaf windows");
  const selectedJobIds = [...new Set(selected.map((row) => row.job_id))];
  let polls = 0;
  const pollObservations: Array<Record<string, unknown>> = [];
  const metricPath = join(input.butlerData, "metrics/operational-events.jsonl");
  const metricStart = existsSync(metricPath) ? statSync(metricPath).size : 0;
  const queryIntervals: Array<{ query_id: string; started_at: string; ended_at: string }> = [];
  const rawNativeRefs: Array<{ mode: "graph" | "hybrid"; query_id: string; repetition: number; ref: string; sha256: string }> = [];
  const completedUnits: Array<{ unit_id: string; job_id: string; source_ids_json: string;
    metric_start: number; metric_end: number }> = [];
  const selectedLineageSources = () => {
    const db = new Database(input.graphPath, { readonly: true });
    try {
      return new Map(selected.map((window) => {
        const rows = db.query<{ source_refs_json: string }, [string]>(`
          WITH RECURSIVE lineage(window_ref,source_refs_json) AS (
            SELECT window_ref,source_refs_json FROM memory_projection_windows WHERE window_ref=?
            UNION ALL
            SELECT child.window_ref,child.source_refs_json FROM memory_projection_windows child
            JOIN lineage parent ON child.parent_window_ref=parent.window_ref
          ) SELECT source_refs_json FROM lineage
        `).all(window.window_ref);
        return [window.window_ref, new Set(rows.flatMap((row) => JSON.parse(row.source_refs_json) as string[]))] as const;
      }));
    } finally { db.close(); }
  };
  const selectedUnit = (unit: ReturnType<typeof t4VectorUnitStates>[number],
    lineages: ReturnType<typeof selectedLineageSources>) => Boolean(unit.source_ids_json &&
    [...lineages.values()].some((sources) =>
      (JSON.parse(unit.source_ids_json!) as string[]).some((source) => sources.has(source))));
  const metricEvents = (start: number, end: number) => !existsSync(metricPath) || end <= start ? []
    : readFileSync(metricPath).subarray(start, end).toString("utf8").split("\n").filter(Boolean)
      .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  let contentionStartedAt: string | null = null;
  let contentionQueries: ReturnType<typeof runT4NativePerformance> | null = null;
  let contentionSamples: Awaited<ReturnType<typeof runT4NativePerformance>> | null = null;
  while (polls < input.options.projectionMaxPollCalls) {
    polls += 1;
    const beforeUnits = new Map(t4VectorUnitStates(input.graphPath).map((unit) => [unit.unit_id, unit]));
    const beforeMetric = existsSync(metricPath) ? statSync(metricPath).size : 0;
    const progressPromise = pollOneQuantum();
    let progressSettled = false;
    void progressPromise.then(() => { progressSettled = true; }, () => { progressSettled = true; });
    while (!contentionQueries && !progressSettled) {
      const currentMetric = existsSync(metricPath) ? statSync(metricPath).size : beforeMetric;
      const started = metricEvents(beforeMetric, currentMetric).find((event) =>
        event.name === "embedding_queue_started" && event.dimensions?.request_class === "background");
      const runningLineages = started ? selectedLineageSources() : null;
      const runningSelected = runningLineages && t4VectorUnitStates(input.graphPath).some((unit) =>
        unit.state === "running" && selectedUnit(unit, runningLineages));
      if (started && runningSelected) {
        contentionStartedAt = new Date(started.ts).toISOString();
        contentionQueries = runT4NativePerformance({ ...input, binding, inventoryHash,
          artifactDir: input.options.artifactDir, modes: ["graph"], repetitions: [0], deadlineAt,
          onInterval: (interval) => queryIntervals.push(interval), onRawResult: (ref) => rawNativeRefs.push(ref) });
        // Observe early rejection while the current quantum finishes; its boundary awaits the original promise.
        void contentionQueries.catch(() => undefined);
        break;
      }
      await Bun.sleep(1);
    }
    const progress = await progressPromise;
    const afterMetric = existsSync(metricPath) ? statSync(metricPath).size : beforeMetric;
    const afterUnits = t4VectorUnitStates(input.graphPath);
    const afterLineages = selectedLineageSources();
    const quantumMetricEvents = metricEvents(beforeMetric, afterMetric);
    const actualBackgroundQuantum = ["admitted", "started", "settled"].every((phase) =>
      quantumMetricEvents.some((event) => event.name === `embedding_queue_${phase}` &&
        event.dimensions?.request_class === "background"));
    pollObservations.push({ ordinal: polls, phase: contentionQueries ? "contention" : "reach_contention",
      action: progress.action, metric_byte_start: beforeMetric, metric_byte_end: afterMetric,
      metric_events: quantumMetricEvents,
      vector_units_before: [...beforeUnits.values()], vector_units_after: t4VectorUnitStates(input.graphPath) });
    for (const unit of afterUnits) if (actualBackgroundQuantum && selectedUnit(unit, afterLineages) &&
      unit.state === "complete" && unit.source_ids_json && JSON.parse(unit.receipt_json ?? "null")?.inference_reused !== true &&
      beforeUnits.get(unit.unit_id)?.state !== "complete" && !completedUnits.some((item) => item.unit_id === unit.unit_id)) {
      completedUnits.push({ unit_id: unit.unit_id, job_id: unit.job_id,
        source_ids_json: unit.source_ids_json, metric_start: beforeMetric, metric_end: afterMetric });
    }
    if (!contentionQueries && completedUnits.length > 0) {
      throw new Error("T4 contention missed the first selected background start boundary");
    }
    if (contentionQueries && !contentionSamples) contentionSamples = await contentionQueries;
    if (progress.action === "idle" && t4PendingProjectionCount(input.graphPath) === 0) break;
  }
  if (!contentionQueries || !contentionSamples || !contentionStartedAt) {
    throw new Error("T4 contention never observed selected background work");
  }
  const contentionEndedAt = new Date().toISOString();
  const metricEnd = existsSync(metricPath) ? statSync(metricPath).size : metricStart;
  const rawMetricFile = writeT4Evidence(input.options.artifactDir, "contention/metric-byte-interval.json", {
    schema: "butler.memory-operational-metric-byte-interval.v1", path: metricPath,
    byte_start: metricStart, byte_end: metricEnd, started_at: contentionStartedAt, ended_at: contentionEndedAt,
  });
  while (polls < input.options.projectionMaxPollCalls && t4PendingProjectionCount(input.graphPath) > 0) {
    polls += 1;
    const before = t4VectorUnitStates(input.graphPath);
    const progress = await pollOneQuantum();
    pollObservations.push({ ordinal: polls, phase: "drain", action: progress.action,
      vector_units_before: before, vector_units_after: t4VectorUnitStates(input.graphPath) });
    if (progress.action === "idle") break;
  }
  const selectedState = t4SelectedProjectionState(input.graphPath, selectedJobIds);
  const currentState = t4SelectedProjectionState(input.graphPath, [...new Set(currentJobIds)]);
  if (t4PendingProjectionCount(input.graphPath) > 0 || selectedState.failed.length || selectedState.invalid.length ||
    selectedState.active.length || selectedState.notConfigured.length || currentState.failed.length ||
    currentState.invalid.length || currentState.active.length || currentState.notConfigured.length) {
    throw new Error(`T4 selected projections did not reach supported terminal stages: ${t4Json(selectedState)}`);
  }
  const warmups = await runT4NativePerformance({ ...input, binding, inventoryHash, artifactDir: join(input.options.artifactDir, "warmup"),
    modes: ["graph", "hybrid"], repetitions: [0], deadlineAt, onRawResult: (ref) => rawNativeRefs.push({ ...ref, ref: `warmup/${ref.ref}` }) });
  const samples = await runT4NativePerformance({ ...input, binding, inventoryHash, artifactDir: input.options.artifactDir,
    modes: ["graph", "hybrid"], repetitions: [1, 2, 3, 4, 5], deadlineAt, onRawResult: (ref) => rawNativeRefs.push(ref) });
  assertBudget();
  const p95 = (mode: "graph" | "hybrid") => samples.filter((sample) => sample.mode === mode)
    .map((sample) => sample.elapsed_ms).sort((left, right) => left - right)[56]!;
  if (samples.filter((sample) => sample.mode === "graph").length !== 60 ||
    samples.filter((sample) => sample.mode === "hybrid").length !== 60 || p95("graph") > 500 || p95("hybrid") > 1_500) {
    throw new Error("T4 prepared performance threshold failed");
  }
  const inventory = readAcceptedCorpusState(input.graphPath);
  let queueWorkRefs: MemoryRecoveryPerformanceReport["contention"]["queue_work_refs"] = [];
  {
    const lineageSources = selectedLineageSources();
    const assignments = new Map<string, { unit: typeof completedUnits[number]; windowIds: string[] }>();
    for (const window of selected) {
      const sources = lineageSources.get(window.window_ref)!;
      const unit = completedUnits.find((candidate) =>
        JSON.parse(candidate.source_ids_json).some((source: string) => sources.has(source)));
      if (!unit) throw new Error("T4 contention vector/window lineage evidence is incomplete");
      const assignment = assignments.get(unit.unit_id) ?? { unit, windowIds: [] };
      assignment.windowIds.push(window.window_ref);
      assignments.set(unit.unit_id, assignment);
    }
    for (const { unit, windowIds } of assignments.values()) {
      const interval = readFileSync(metricPath).subarray(unit.metric_start, unit.metric_end).toString("utf8");
      const events = interval.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const admitted = events.find((event) => event.name === "embedding_queue_admitted" && event.dimensions?.request_class === "background");
      const started = events.find((event) => event.name === "embedding_queue_started" && event.dimensions?.request_class === "background");
      const settled = events.find((event) => event.name === "embedding_queue_settled" && event.dimensions?.request_class === "background");
      if (!admitted || !started || !settled || admitted.ts > started.ts || started.ts >= settled.ts) {
        throw new Error("T4 contention queue/window evidence is incomplete");
      }
      const evidence: MemoryQueueWorkEvidence = { schema: "butler.memory-queue-work-evidence.v1", result_id: unit.unit_id,
        source_window_ids: windowIds, started_at: new Date(started.ts).toISOString(),
        ended_at: new Date(settled.ts).toISOString(), work_class: "background" };
      const file = writeT4Evidence(input.options.artifactDir, `contention/${unit.unit_id}.json`, evidence);
      queueWorkRefs.push({ ref: file.ref, sha256: file.sha256, started_at: evidence.started_at,
        ended_at: evidence.ended_at, result_id: evidence.result_id, source_window_ids: evidence.source_window_ids });
    }
  }
  if (!queryIntervals.some((query) => queueWorkRefs.some((work) =>
    Date.parse(query.started_at) < Date.parse(work.ended_at) && Date.parse(work.started_at) < Date.parse(query.ended_at)))) {
    throw new Error("T4 contention did not observe a real query/background overlap");
  }
  const manifest = JSON.parse(readFileSync(join(dirname(input.graphPath), "manifest.json"), "utf8"));
  const implementationCommit = process.env.BUTLER_IMPLEMENTATION_COMMIT?.trim();
  if (!implementationCommit || !/^[0-9a-f]{40,64}$/u.test(implementationCommit) || !manifest.embedding?.version) {
    throw new Error("T4 performance requires the frozen implementation commit and embedding version");
  }
  const report: MemoryRecoveryPerformanceReport = { schema: "butler.memory-recovery-performance.v1",
    execution: { generation_id: input.generationId, implementation_commit: implementationCommit,
      embedding_version: manifest.embedding.version, qualification_source_inventory_hash: inventoryHash },
    samples, contention: { source_window_ids: selected.map((row) => row.window_ref), query_intervals: queryIntervals,
      queue_work_refs: queueWorkRefs, overlapped: true } };
  const reportFile = writeT4Evidence(input.options.artifactDir, "performance-report.json", report);
  const graphEvidence = new Database(input.graphPath, { readonly: true });
  let projectionEvidence: { completion_ids: string[]; projection_job_ids: string[];
    extractor_attempt_refs: Array<{ ref: string; sha256: string }>;
    embedding_receipt_refs: Array<{ ref: string; sha256: string }> };
  try {
    const attempts = graphEvidence.query<any, []>("SELECT * FROM memory_projection_attempts ORDER BY rowid").all();
    const receipts = graphEvidence.query<any, []>(
      "SELECT * FROM memory_vector_units WHERE state='complete' AND receipt_json IS NOT NULL ORDER BY rowid",
    ).all();
    const jobs = graphEvidence.query<any, []>("SELECT * FROM memory_projection_jobs ORDER BY rowid").all();
    const attemptFile = writeT4Evidence(input.options.artifactDir, "projection/extractor-attempts.json", attempts);
    const receiptFile = writeT4Evidence(input.options.artifactDir, "projection/embedding-receipts.json", receipts);
    projectionEvidence = {
      completion_ids: jobs.map((job) => job.completion_job_id).filter((id): id is string => typeof id === "string"),
      projection_job_ids: jobs.map((job) => job.job_id).filter((id): id is string => typeof id === "string"),
      extractor_attempt_refs: attempts.length ? [{ ref: attemptFile.ref, sha256: attemptFile.sha256 }] : [],
      embedding_receipt_refs: receipts.length ? [{ ref: receiptFile.ref, sha256: receiptFile.sha256 }] : [],
    };
  } finally { graphEvidence.close(); }
  const raw = writeT4Evidence(input.options.artifactDir, "raw-performance.json", {
    schema: "butler.memory.t4-performance-raw.v1", generation_id: input.generationId,
    query_binding_sha256: T4_PERFORMANCE_QUERY_BINDING_SHA, source_binding_sha256: T4_PERFORMANCE_SOURCE_BINDING_SHA,
    supplements, selected_window_ids: selected.map((row) => row.window_ref),
    selected_window_source_ids: Object.fromEntries(selected.map((row) => [row.window_ref, row.source_ids])),
    contention_samples: contentionSamples, warmup_samples: warmups, samples, raw_native_result_refs: rawNativeRefs,
    metric_interval: { ref: rawMetricFile.ref, sha256: rawMetricFile.sha256 },
    poll_observations: pollObservations, poll_calls: polls,
    completed_vector_units: completedUnits,
    projection_evidence: projectionEvidence,
    final_inventory: inventory, qualification_source_inventory: { ref: inventoryFile.ref, sha256: inventoryFile.sha256,
      inventory_hash: inventoryHash }, performance_report: { ref: reportFile.ref, sha256: reportFile.sha256 },
    status: "pending_root_semantic_review",
  });
  return { raw_path: raw.path, raw_sha256: raw.sha256, samples: samples.length, selected_window_ids: selected.map((row) => row.window_ref), polls };
}

export async function finalizeT4Qualification(input: {
  tracePath: string; semanticReviewPath: string; performanceRawPath: string;
  ownerEvidenceDir: string; supportEvidenceDir: string; outputDir: string; implementationCommit: string;
}) {
  if (resolve(input.outputDir) !== resolve(dirname(input.performanceRawPath))) {
    throw new Error("T4 qualification evidence must share one verification root");
  }
  const traceSha = sha(readFileSync(input.tracePath, "utf8"));
  const review = JSON.parse(readFileSync(input.semanticReviewPath, "utf8")) as { trace_sha256?: string; outcome?: string };
  if (review.trace_sha256 !== traceSha || review.outcome !== "accepted") throw new Error("T4 qualification requires accepted semantic review of this exact trace");
  const raw = JSON.parse(readFileSync(input.performanceRawPath, "utf8")) as any;
  if (raw.schema !== "butler.memory.t4-performance-raw.v1" || raw.status !== "pending_root_semantic_review" ||
    raw.query_binding_sha256 !== T4_PERFORMANCE_QUERY_BINDING_SHA || raw.source_binding_sha256 !== T4_PERFORMANCE_SOURCE_BINDING_SHA) {
    throw new Error("T4 qualification requires the frozen raw performance artifact");
  }
  const performancePath = resolve(dirname(input.performanceRawPath), raw.performance_report?.ref ?? "");
  if (sha(readFileSync(performancePath, "utf8")) !== raw.performance_report?.sha256) throw new Error("T4 performance report changed");
  const report = JSON.parse(readFileSync(performancePath, "utf8")) as MemoryRecoveryPerformanceReport;
  const ownerFiles = ["t6-b-app-owner-result.json", "t6-b-identity-owner-result.json", "t6-b-rebuild-owner-result.json"];
  const ownerRefs = ownerFiles.map((name) => {
    const path = join(input.ownerEvidenceDir, name);
    const value = JSON.parse(readFileSync(path, "utf8")) as MemoryOwnerResultEvidence;
    if (value.schema !== "butler.memory-owner-result-evidence.v1" || !value.result_id || !value.generation_id ||
      !["ok", "partial"].includes(value.status) || !Array.isArray(value.source_handles) || !Array.isArray(value.observations)) {
      throw new Error(`T4 owner evidence is invalid: ${name}`);
    }
    const copiedResult = copyT4Evidence(input.outputDir, path, `owner/${name}`);
    const facts = join(input.ownerEvidenceDir, name.replace("owner-result", "source-facts"));
    const copiedFacts = existsSync(facts)
      ? copyT4Evidence(input.outputDir, facts, `owner/${name.replace("owner-result", "source-facts")}`) : null;
    if (name !== "t6-b-identity-owner-result.json" && !copiedFacts) {
      throw new Error(`T4 owner source facts are missing: ${facts}`);
    }
    return { name, value, ref: copiedResult.ref, sha256: copiedResult.sha256,
      facts_ref: copiedFacts?.ref, facts_sha256: copiedFacts?.sha256 };
  });
  const copiedTrace = copyT4Evidence(input.outputDir, input.tracePath, "runs/memory-t4-resume-trace.json");
  const copiedReview = copyT4Evidence(input.outputDir, input.semanticReviewPath, "reviews/root-semantic-review.json");
  const publicTrace = JSON.parse(readFileSync(input.tracePath, "utf8")) as any;
  const supportingFiles = ["t3-correction02-t1-focused-03.log", "t5-a-candidate06-result.md",
    "t5-c-root-accepted-result-04.md", "t5-d-acceptance-report-report-memory-recovery-t5-result-16-body.md",
    "t6-a-saved-plan-fxmr3ow8/result.json", "actual11-result-summary.json", "actual11-closed-report-body.md",
    "actual12-binding-audit-result.json", "actual12-binding-independent-review.md"];
  const supportRefs = supportingFiles.map((name) => {
    const path = join(input.supportEvidenceDir, name);
    if (!existsSync(path)) throw new Error(`T4 preserved supporting evidence is missing: ${name}`);
    return copyT4Evidence(input.outputDir, path, `support/${name}`);
  });
  if (!/^[0-9a-f]{40,64}$/u.test(input.implementationCommit)) throw new Error("T4 implementation commit is invalid");
  const inventoryRef = raw.qualification_source_inventory?.ref;
  const inventorySha = raw.qualification_source_inventory?.sha256;
  const inventoryHash = raw.qualification_source_inventory?.inventory_hash;
  if (typeof inventoryRef !== "string" || typeof inventorySha !== "string" || typeof inventoryHash !== "string" ||
    sha(readFileSync(join(input.outputDir, inventoryRef), "utf8")) !== inventorySha) {
    throw new Error("T4 qualification source inventory is missing or changed");
  }
  const projection = raw.projection_evidence;
  if (!projection?.completion_ids?.length || !projection?.projection_job_ids?.length ||
    !projection?.extractor_attempt_refs?.length || !projection?.embedding_receipt_refs?.length) {
    throw new Error("T4 public case lacks actual completion/job/extractor/embedding evidence");
  }
  const sourceObservations = (refs: Array<{ ref: string; sha256: string }>) => refs.map((ref) => {
    const binding = JSON.parse(readFileSync(join(input.outputDir, ref.ref), "utf8")) as MemorySourceBindingEvidence;
    if (sha(readFileSync(join(input.outputDir, ref.ref), "utf8")) !== ref.sha256 || !binding.source_row) {
      throw new Error(`T4 source binding changed: ${ref.ref}`);
    }
    const identity = binding.observation_kind === "session_message" && binding.canonical
      ? { kind: "conversation_source" as const, message_id: binding.canonical.message_id,
        part_id: binding.canonical.part_id, scalar_pointer: binding.canonical.scalar_pointer }
      : { kind: "memory_source" as const, source_id: binding.source_row.source_id };
    return { handle: binding.handle, identity,
      revision: binding.revision, source_hash: binding.source_hash, observed_at: binding.observed_at,
      currentness: binding.currentness, inventory_hash: binding.inventory_hash,
      binding_ref: ref.ref, binding_sha256: ref.sha256 };
  });
  const execution = { generation_id: report.execution.generation_id, implementation_commit: input.implementationCommit,
    tool_contract_version: 2 as const, extraction_version: "memory-extract-v2" as const,
    embedding: { status: "executed" as const, version: report.execution.embedding_version },
    stage_source_inventory_hash: inventoryHash, source_inventory_ref: inventoryRef, source_inventory_sha256: inventorySha };
  const cases: MemoryRecoveryAcceptance["cases"] = [];
  const addCase = (id: string, mrIds: string[], path: MemoryRecoveryAcceptance["cases"][number]["path"],
    queryHash: string, traceValue: MemoryRecoveryCaseTrace, flags: { extractor: boolean; embedding: boolean }) => {
    const traceFile = writeT4Evidence(input.outputDir, `cases/${id}.json`, traceValue);
    cases.push({ id, mr_ids: mrIds, query_hash: queryHash, source_refs: traceValue.observed_source_handles,
      expected_source_refs: traceValue.expected_source_handles, observed_source_refs: traceValue.observed_source_handles,
      outcome: "passed", path, uses_real_extractor: flags.extractor, uses_real_embedding: flags.embedding,
      trace_ref: traceFile.ref, trace_sha256: traceFile.sha256 });
  };
  const observationPath = join(dirname(input.tracePath), "memory-t4-resume-observation.json");
  const observation = JSON.parse(readFileSync(observationPath, "utf8")) as any;
  const graphPath = join(dirname(input.tracePath), "cognition/memory/generations", report.execution.generation_id, "graph.sqlite");
  const projectPublicPhase = async (phase: "Q1" | "ARABIC", question: string, mrIds: string[]) => {
    const stage = phase === "Q1" ? publicTrace.q1_stage_inventory : publicTrace.arabic_stage_inventory;
    if (!stage?.ref || !stage?.sha256 || !stage?.inventory_hash ||
      sha(readFileSync(join(input.outputDir, stage.ref), "utf8")) !== stage.sha256) {
      throw new Error(`T4 ${phase} actual stage inventory is missing or changed`);
    }
    const phaseExecutionBase = { ...execution, generation_id: stage.generation_id,
      stage_source_inventory_hash: stage.inventory_hash, source_inventory_ref: stage.ref,
      source_inventory_sha256: stage.sha256 };
    const phaseObservation = phase === "Q1" && publicTrace.q1_provenance?.mode === "accepted_phase_reuse"
      ? JSON.parse(readFileSync(join(input.outputDir, "historical-q1/memory-t4-resume-observation.json"), "utf8"))
      : observation;
    const calls = (phaseObservation.q1_calls ?? []).filter((call: any) => call.phase === phase);
    const callsFile = writeT4Evidence(input.outputDir, `cases/${phase.toLowerCase()}-tool-observations.json`, calls);
    const verified = phase === "Q1" ? publicTrace.recall_observation?.this_week_sources ?? []
      : publicTrace.arabic_evidence?.verified_sources ?? [];
    if (!verified.length || (phase === "Q1" && new Set(verified.map((item: any) => item.session_id)).size < 2)) {
      throw new Error(`T4 ${phase} accepted verifier facts are incomplete`);
    }
    const stageInventory = JSON.parse(readFileSync(join(input.outputDir, stage.ref), "utf8")) as any;
    const { projectionHash, splitUtf8Spans } = await import(
      "../../packages/butler-agent/src/agent/cognition/memory/projection/source.ts"
    );
    const canonicalInventoryRow = (messageId: string,
      scalarId: { part_id: string; pointer: string; text: string; hash: string }) => {
      const canonical = t4CanonicalMessage(dirname(input.tracePath), messageId);
      if (!canonical?.eligible) throw new Error(`T4 ${phase} canonical source is unavailable`);
      const selected = canonical.scalars.find((scalar) => scalar.part_id === scalarId.part_id &&
        scalar.pointer === scalarId.pointer && scalar.hash === scalarId.hash && scalar.text === scalarId.text);
      if (!selected) throw new Error(`T4 ${phase} accepted scalar identity changed`);
      for (const entry of stageInventory.entries ?? []) for (const span of splitUtf8Spans(selected.text, 32 * 1024)) {
        const sourceId = projectionHash(["memory-source", entry.episodeId, entry.revision, "conversation",
          canonical.message_id, selected.part_id, selected.pointer, span.start, span.end, selected.hash]);
        if (entry.sourceIds?.includes(sourceId)) return { canonical, scalar: selected, entry, sourceId, span };
      }
      throw new Error(`T4 ${phase} canonical source is absent from its phase inventory`);
    };
    for (const [ordinal, fact] of verified.entries()) {
      const call = fact.source_ref ? fact.read_pages[0] : fact.producer_call;
      const delivery = { operation_call_id: call?.operation_call_id, output: call?.output };
      if (!call || !delivery.operation_call_id || !delivery.output) {
        throw new Error(`T4 ${phase} accepted source-read fact is incomplete`);
      }
      let handles: string[] = [];
      let bindingFiles: Array<{ ref: string; sha256: string }> = [];
      let observations: MemoryQueryResultEvidence["observations"] = [];
      if (fact.source_ref) {
        handles = [fact.source_ref];
        observations = [{ kind: "source_ref", source_ref: fact.source_ref }];
        const pages = fact.read_pages;
        const fullText = pages.map((page: any) => page.output.text).join("");
        if (!pages.length || fullText !== fact.scalar_ids[0]?.text || sha(fullText) !== fact.source_hash) {
          throw new Error(`T4 ${phase} accepted source pages changed`);
        }
        const pageFile = writeT4Evidence(input.outputDir, `cases/${phase.toLowerCase()}-${ordinal}-source-pages.json`, pages);
        if (fact.source_ref.startsWith("memory-source:v2:")) {
          bindingFiles = [await writeT4PerformanceSourceEvidence({ butlerData: dirname(input.tracePath), graphPath,
            generationId: stage.generation_id, artifactDir: input.outputDir, resultId: delivery.operation_call_id,
            handle: fact.source_ref, currentness: "current", inventoryHash: stage.inventory_hash,
            nativeRead: { text: fullText, ref: pageFile.ref, sha256: pageFile.sha256 } })];
        } else {
          const matched = canonicalInventoryRow(fact.message_id, fact.scalar_ids[0]);
          if (fullText !== matched.scalar.text) throw new Error(`T4 ${phase} canonical source read changed`);
          const row = { source_id: matched.sourceId, episode_id: matched.entry.episodeId,
            revision: matched.entry.revision, content_hash: matched.scalar.hash,
            conversation_session_id: matched.canonical.session_id, conversation_message_id: matched.canonical.message_id,
            part_id: matched.scalar.part_id, scalar_pointer: matched.scalar.pointer,
            byte_start: matched.span.start, byte_end: matched.span.end, observed_at: matched.canonical.created_at,
            conversation_start: matched.canonical.conversation_start, conversation_end: matched.canonical.conversation_end,
            project_id: matched.canonical.project_id };
          const read: MemorySourceReadEvidence = { schema: "butler.memory-source-read-evidence.v1",
            result_id: delivery.operation_call_id, observation_kind: "source_ref", source_ref: fact.source_ref,
            message_id: null, canonical: { message_id: matched.canonical.message_id, part_id: matched.scalar.part_id,
              scalar_pointer: matched.scalar.pointer, text: matched.scalar.text, bytes: Buffer.byteLength(matched.scalar.text),
              sha256: matched.scalar.hash, revision: matched.entry.revision }, returned_text: fullText, source_row: row };
          const readFile = writeT4Evidence(input.outputDir, `cases/${phase.toLowerCase()}-${ordinal}-canonical-read.json`, read);
          const binding: MemorySourceBindingEvidence = { schema: "butler.memory-source-binding-evidence.v1",
            handle: fact.source_ref, observation_kind: "source_ref", returned_source_ref: fact.source_ref,
            returned_message_id: null, generation_id: stage.generation_id, inventory_hash: stage.inventory_hash,
            revision: matched.entry.revision, source_hash: matched.scalar.hash, observed_at: matched.canonical.created_at,
            currentness: "current", returned_in_result_id: delivery.operation_call_id,
            read_result_ref: readFile.ref, read_result_sha256: readFile.sha256, source_row: row,
            chunk: { current_revision: matched.entry.revision, status: "active" },
            canonical: { message_id: matched.canonical.message_id, part_id: matched.scalar.part_id,
              scalar_pointer: matched.scalar.pointer, scalar_hash: matched.scalar.hash, revision: matched.entry.revision } };
          bindingFiles = [writeT4Evidence(input.outputDir, `cases/${phase.toLowerCase()}-${ordinal}-canonical-binding.json`, binding)];
        }
      } else {
        if (!fact.returned_message || !fact.scalar_ids.length) {
          throw new Error(`T4 ${phase} accepted session message is incomplete`);
        }
        observations = [{ kind: "session_message", message_id: fact.message_id }];
        for (const [scalarOrdinal, scalarId] of fact.scalar_ids.entries()) {
          const matched = canonicalInventoryRow(fact.message_id, scalarId);
          const canonical = matched.canonical;
          const scalar = matched.scalar;
          const privateHandle = `session-message:${sha(t4Json([canonical.message_id, scalar.part_id, scalar.pointer]))}`;
          const row = { source_id: matched.sourceId, episode_id: matched.entry.episodeId, revision: matched.entry.revision,
            content_hash: scalar.hash, conversation_session_id: canonical.session_id,
            conversation_message_id: canonical.message_id, part_id: scalar.part_id, scalar_pointer: scalar.pointer,
            byte_start: matched.span.start, byte_end: matched.span.end, observed_at: canonical.created_at,
            conversation_start: canonical.conversation_start, conversation_end: canonical.conversation_end,
            project_id: canonical.project_id };
          const read: MemorySourceReadEvidence = { schema: "butler.memory-source-read-evidence.v1",
            result_id: delivery.operation_call_id, observation_kind: "session_message", source_ref: null,
            message_id: canonical.message_id, canonical: { message_id: canonical.message_id, part_id: scalar.part_id,
              scalar_pointer: scalar.pointer, text: scalarId.text, bytes: Buffer.byteLength(scalarId.text),
              sha256: scalar.hash, revision: matched.entry.revision }, returned_text: scalarId.text, source_row: row };
          const readFile = writeT4Evidence(input.outputDir,
            `cases/${phase.toLowerCase()}-${ordinal}-session-${scalarOrdinal}-read.json`, read);
          const binding: MemorySourceBindingEvidence = { schema: "butler.memory-source-binding-evidence.v1",
            handle: privateHandle, observation_kind: "session_message", returned_source_ref: null,
            returned_message_id: canonical.message_id, generation_id: stage.generation_id,
            inventory_hash: stage.inventory_hash, revision: matched.entry.revision, source_hash: scalar.hash,
            observed_at: canonical.created_at, currentness: "current", returned_in_result_id: delivery.operation_call_id,
            read_result_ref: readFile.ref, read_result_sha256: readFile.sha256, source_row: row,
            chunk: { current_revision: matched.entry.revision, status: "active" },
            canonical: { message_id: canonical.message_id, part_id: scalar.part_id,
              scalar_pointer: scalar.pointer, scalar_hash: scalar.hash, revision: matched.entry.revision } };
          bindingFiles.push(writeT4Evidence(input.outputDir,
            `cases/${phase.toLowerCase()}-${ordinal}-session-${scalarOrdinal}-binding.json`, binding));
          handles.push(privateHandle);
        }
      }
      const queryHash = sha(t4Json(call.args));
      const selectedRows = bindingFiles.map((item) =>
        (JSON.parse(readFileSync(join(input.outputDir, item.ref), "utf8")) as MemorySourceBindingEvidence).source_row!);
      const selectedLineage = (stage.source_lineage ?? []).filter((lineage: any) => selectedRows.some((row) =>
        row.episode_id === lineage.episode_id && row.revision === lineage.revision));
      const selectedJobs = selectedLineage.map((lineage: any) => lineage.job);
      const selectedAttempts = selectedLineage.flatMap((lineage: any) => lineage.attempts ?? []);
      const selectedReceipts = selectedLineage.flatMap((lineage: any) => lineage.receipts ?? []);
      const selectedAttemptFile = selectedAttempts.length ? writeT4Evidence(input.outputDir,
        `cases/${phase.toLowerCase()}-${ordinal}-extractor-attempts.json`, selectedAttempts) : null;
      const selectedReceiptFile = selectedReceipts.length ? writeT4Evidence(input.outputDir,
        `cases/${phase.toLowerCase()}-${ordinal}-embedding-receipts.json`, selectedReceipts) : null;
      const usesEmbedding = false;
      const usesExtractor = phase === "ARABIC" && selectedAttempts.some((attempt: any) =>
        attempt.provider_invoked === 1 && attempt.outcome_known === 1 && attempt.state === "provider_result" && attempt.output_json);
      if (phase === "ARABIC" && !usesExtractor) {
        throw new Error(`T4 ${phase} operation lacks its phase-time execution evidence`);
      }
      const phaseExecution = { ...phaseExecutionBase, embedding: usesEmbedding
        ? { status: "executed" as const, version: report.execution.embedding_version }
        : { status: "not_executed" as const, reason: "not_required" as const } };
      const result: MemoryQueryResultEvidence = { schema: "butler.memory-query-result-evidence.v1",
        request_id: call.id, result_id: delivery.operation_call_id, generation_id: stage.generation_id,
        query_hash: queryHash, status: delivery.output?.status === "partial" ? "partial" : "ok",
        source_handles: fact.source_ref ? handles : [], observations };
      const resultFile = writeT4Evidence(input.outputDir, `cases/${phase.toLowerCase()}-${ordinal}-result.json`, result);
      const assignedMrs = ordinal === 0 ? mrIds : [];
      addCase(`public-${phase.toLowerCase()}-${ordinal + 1}`, assignedMrs, "public_app_btcc", queryHash,
        { schema: "butler.memory-recovery-case-trace.v1", execution: phaseExecution,
          query: { sha256: queryHash, request_id: call.id,
            result_refs: [{ result_id: result.result_id, ref: resultFile.ref, sha256: resultFile.sha256 }] },
          qualification_source_inventory_hash: inventoryHash, qualification_source_inventory_ref: inventoryRef,
          qualification_source_inventory_sha256: inventorySha, source_observations: sourceObservations(bindingFiles),
          completion_ids: selectedJobs.flatMap((job: any) => JSON.parse(job.observed_completion_job_ids ?? "[]")),
          projection_job_ids: selectedJobs.map((job: any) => job.job_id), native_result_ids: [result.result_id],
          extractor_attempt_refs: selectedAttemptFile ? [{ ref: selectedAttemptFile.ref, sha256: selectedAttemptFile.sha256 }] : [],
          embedding_receipt_refs: selectedReceiptFile && usesEmbedding
            ? [{ ref: selectedReceiptFile.ref, sha256: selectedReceiptFile.sha256 }] : [], expected_source_handles: handles,
          expected_source_groups: handles.map((handle) => [handle]), observed_source_handles: handles,
          supporting_execution_refs: [{ ref: copiedTrace.ref, sha256: copiedTrace.sha256 },
            { ref: copiedReview.ref, sha256: copiedReview.sha256 }, { ref: callsFile.ref, sha256: callsFile.sha256 },
            ...(phase === "Q1" ? supportRefs.filter((ref) => ref.ref.includes("t3-correction") || ref.ref.includes("saved-plan")) : []),
            ...(phase === "ARABIC" ? supportRefs.filter((ref) => ref.ref.includes("actual12-")) : [])],
        }, { extractor: usesExtractor, embedding: usesEmbedding });
    }
  };
  if (publicTrace.q1_provenance?.mode !== "accepted_phase_reuse") {
    await projectPublicPhase("Q1", T4_Q1, ["MR-01", "MR-06"]);
  }
  await projectPublicPhase("ARABIC", T4_ARABIC_Q, ["MR-01", "MR-03", "MR-05", "MR-07"]);
  const native = report.samples.find((sample) => sample.mode === "hybrid" && sample.query_id === "Q03" && sample.repetition === 1);
  if (!native) throw new Error("T4 native hybrid Q03 measured result is missing");
  const nativeResult = JSON.parse(readFileSync(join(input.outputDir, native.result_ref), "utf8")) as MemoryQueryResultEvidence;
  addCase("native-hybrid-source-read", ["MR-07", "MR-08", "MR-09"], "native_tool", native.query_hash,
    { schema: "butler.memory-recovery-case-trace.v1", execution,
      query: { sha256: native.query_hash, request_id: nativeResult.request_id,
        result_refs: [{ result_id: native.result_id, ref: native.result_ref, sha256: native.result_sha256 }] },
      qualification_source_inventory_hash: inventoryHash, qualification_source_inventory_ref: inventoryRef,
      qualification_source_inventory_sha256: inventorySha, source_observations: sourceObservations(native.source_binding_refs),
      completion_ids: [], projection_job_ids: [], native_result_ids: [native.result_id],
      extractor_attempt_refs: [], embedding_receipt_refs: projection.embedding_receipt_refs,
      expected_source_handles: native.expected_source_groups.flat(),
      expected_source_groups: native.expected_source_groups, observed_source_handles: native.observed_source_handles,
      supporting_execution_refs: supportRefs.filter((ref) => ref.ref.includes("actual12-")),
    }, { extractor: false, embedding: true });
  const oldNative = report.samples.find((sample) => sample.mode === "graph" && sample.query_id === "Q04" && sample.repetition === 1);
  if (!oldNative) throw new Error("T4 native graph Q04 measured result is missing");
  const oldNativeResult = JSON.parse(readFileSync(join(input.outputDir, oldNative.result_ref), "utf8")) as MemoryQueryResultEvidence;
  addCase("native-old-indirect", ["MR-04", "MR-07"], "native_tool", oldNative.query_hash,
    { schema: "butler.memory-recovery-case-trace.v1", execution: { ...execution,
        embedding: { status: "not_executed", reason: "not_required" } },
      query: { sha256: oldNative.query_hash, request_id: oldNativeResult.request_id,
        result_refs: [{ result_id: oldNative.result_id, ref: oldNative.result_ref, sha256: oldNative.result_sha256 }] },
      qualification_source_inventory_hash: inventoryHash, qualification_source_inventory_ref: inventoryRef,
      qualification_source_inventory_sha256: inventorySha, source_observations: sourceObservations(oldNative.source_binding_refs),
      completion_ids: [], projection_job_ids: [], native_result_ids: [oldNative.result_id],
      extractor_attempt_refs: [], embedding_receipt_refs: [], expected_source_handles: oldNative.expected_source_groups.flat(),
      expected_source_groups: oldNative.expected_source_groups, observed_source_handles: oldNative.observed_source_handles,
      supporting_execution_refs: supportRefs.filter((ref) => ref.ref.includes("actual11-") || ref.ref.includes("actual12-")),
    }, { extractor: false, embedding: false });
  const savedPlanNative = report.samples.find((sample) =>
    sample.mode === "graph" && sample.query_id === "Q09" && sample.repetition === 1);
  if (!savedPlanNative) throw new Error("T4 native graph Q09 measured result is missing");
  const savedPlanResult = JSON.parse(
    readFileSync(join(input.outputDir, savedPlanNative.result_ref), "utf8"),
  ) as MemoryQueryResultEvidence;
  addCase("native-long-source-preservation", ["MR-06"], "native_tool", savedPlanNative.query_hash,
    { schema: "butler.memory-recovery-case-trace.v1", execution: { ...execution,
        embedding: { status: "not_executed", reason: "not_required" } },
      query: { sha256: savedPlanNative.query_hash, request_id: savedPlanResult.request_id,
        result_refs: [{ result_id: savedPlanNative.result_id, ref: savedPlanNative.result_ref,
          sha256: savedPlanNative.result_sha256 }] },
      qualification_source_inventory_hash: inventoryHash, qualification_source_inventory_ref: inventoryRef,
      qualification_source_inventory_sha256: inventorySha,
      source_observations: sourceObservations(savedPlanNative.source_binding_refs),
      completion_ids: [], projection_job_ids: [], native_result_ids: [savedPlanNative.result_id],
      extractor_attempt_refs: [], embedding_receipt_refs: [],
      expected_source_handles: savedPlanNative.expected_source_groups.flat(),
      expected_source_groups: savedPlanNative.expected_source_groups,
      observed_source_handles: savedPlanNative.observed_source_handles,
      supporting_execution_refs: [{ ref: copiedTrace.ref, sha256: copiedTrace.sha256 },
        ...supportRefs.filter((ref) => ref.ref.includes("t3-correction") || ref.ref.includes("saved-plan"))],
    }, { extractor: false, embedding: false });
  const { memorySourceInventoryHash } = await import(
    "../../packages/butler-agent/src/agent/cognition/memory/projection/source.ts"
  );
  for (const [name, mrIds, route] of [["t6-b-identity-owner-result.json", ["MR-02"], undefined]] as const) {
    const owner = ownerRefs.find((item) => item.name === name)!;
    const ownerRaw = (owner.value as any).raw_facts;
    const ownerInventoryHash = memorySourceInventoryHash(ownerRaw?.source_inventory);
    if (ownerInventoryHash !== ownerRaw?.source_inventory_hash) throw new Error("T4 identity owner inventory changed");
    const ownerInventory = writeT4Evidence(input.outputDir, "owner/identity-source-inventory.json", ownerRaw.source_inventory);
    const queryHash = sha(t4Json(ownerRaw ?? owner.value));
    addCase(name.includes("identity") ? "owner-identity" : "owner-transition", [...mrIds], "owner_integration", queryHash,
      { schema: "butler.memory-recovery-case-trace.v1", execution: { ...execution,
          generation_id: owner.value.generation_id, embedding: { status: "not_executed", reason: "not_required" },
          stage_source_inventory_hash: ownerInventoryHash, source_inventory_ref: ownerInventory.ref,
          source_inventory_sha256: ownerInventory.sha256 },
        query: { sha256: queryHash, result_refs: [] }, qualification_source_inventory_hash: inventoryHash,
        qualification_source_inventory_ref: inventoryRef, qualification_source_inventory_sha256: inventorySha,
        source_observations: [], completion_ids: [], projection_job_ids: [ownerRaw.baseline_job_id, ownerRaw.create_job_id], native_result_ids: [],
        owner_result_refs: [{ ref: owner.ref, sha256: owner.sha256 }], owner_route: route,
        supporting_execution_refs: owner.facts_ref && owner.facts_sha256 ? [{ ref: owner.facts_ref, sha256: owner.facts_sha256 }] : [],
        extractor_attempt_refs: [], embedding_receipt_refs: [], expected_source_handles: [],
        expected_source_groups: [], observed_source_handles: [] }, { extractor: false, embedding: false });
  }
  const rebuildOwner = ownerRefs.find((item) => item.name === "t6-b-rebuild-owner-result.json")!;
  const rebuildFacts = JSON.parse(readFileSync(join(input.outputDir, rebuildOwner.facts_ref!), "utf8")) as any;
  const rebuildInventoryHash = memorySourceInventoryHash(rebuildFacts.snapshot_inventory);
  if (rebuildInventoryHash !== (rebuildOwner.value as any).raw_facts?.source_inventory_hash ||
    !/^[0-9a-f]{64}$/u.test(rebuildFacts.snapshot_inventory_sha256)) {
    throw new Error("T4 rebuild owner snapshot inventory provenance changed");
  }
  const rebuildInventoryFile = writeT4Evidence(input.outputDir, "owner/rebuild-source-inventory.json", rebuildFacts.snapshot_inventory);
  const rebuildBindings = (rebuildFacts.candidate_observations ?? []).filter((fact: any) =>
    rebuildOwner.value.source_handles.includes(fact.source_ref)).map((fact: any) => {
    const resultId = rebuildOwner.value.result_id;
    const read: MemorySourceReadEvidence & { owner_read_provenance: Record<string, unknown> } = {
      schema: "butler.memory-source-read-evidence.v1", result_id: resultId,
      observation_kind: "source_ref", source_ref: fact.source_ref, message_id: null,
      canonical: fact.canonical, returned_text: fact.canonical.text, source_row: fact.source_row,
      owner_read_provenance: { native_operation_id: fact.native_operation_id, read_args: fact.read_args,
        returned_excerpt: fact.returned_excerpt, source_span: fact.source_span } };
    const readFile = writeT4Evidence(input.outputDir, `owner/reads/${sha(fact.source_ref)}.json`, read);
    const binding: MemorySourceBindingEvidence = { schema: "butler.memory-source-binding-evidence.v1",
      handle: fact.source_ref, observation_kind: "source_ref", returned_source_ref: fact.source_ref,
      returned_message_id: null, generation_id: rebuildOwner.value.generation_id,
      inventory_hash: rebuildInventoryHash, revision: fact.source_row.revision, source_hash: fact.source_row.content_hash,
      observed_at: fact.source_row.observed_at, currentness: "as_of", returned_in_result_id: resultId,
      read_result_ref: readFile.ref, read_result_sha256: readFile.sha256, source_row: fact.source_row,
      chunk: { current_revision: fact.source_row.current_revision, status: fact.source_row.chunk_status },
      canonical: { message_id: fact.canonical.message_id, part_id: fact.canonical.part_id,
        scalar_pointer: fact.canonical.scalar_pointer, scalar_hash: fact.canonical.sha256,
        revision: fact.canonical.revision } };
    return writeT4Evidence(input.outputDir, `owner/bindings/${sha(fact.source_ref)}.json`, binding);
  });
  if (rebuildBindings.length !== rebuildOwner.value.source_handles.length) {
    throw new Error("T4 rebuild owner result lacks an exact actual source fact for every returned handle");
  }
  const rebuildQueryHash = sha(t4Json((rebuildOwner.value as any).raw_facts));
  addCase("owner-transition", ["MR-10", "MR-11", "MR-12"], "owner_integration", rebuildQueryHash,
    { schema: "butler.memory-recovery-case-trace.v1", execution: { ...execution,
        generation_id: rebuildOwner.value.generation_id, embedding: { status: "not_executed", reason: "not_required" },
        stage_source_inventory_hash: rebuildInventoryHash, source_inventory_ref: rebuildInventoryFile.ref,
        source_inventory_sha256: rebuildInventoryFile.sha256 }, query: { sha256: rebuildQueryHash, result_refs: [] },
      qualification_source_inventory_hash: inventoryHash, qualification_source_inventory_ref: inventoryRef,
      qualification_source_inventory_sha256: inventorySha, source_observations: sourceObservations(rebuildBindings),
      completion_ids: [], projection_job_ids: (rebuildFacts.stage_inventory?.jobs ?? []).map((job: any) => job.job_id),
      native_result_ids: [], owner_result_refs: [{ ref: rebuildOwner.ref, sha256: rebuildOwner.sha256 }],
      owner_source_result_refs: [{ result_id: rebuildOwner.value.result_id, ref: rebuildOwner.ref, sha256: rebuildOwner.sha256 }],
      owner_route: "production_transition", supporting_execution_refs: [
        { ref: rebuildOwner.facts_ref!, sha256: rebuildOwner.facts_sha256! },
        ...supportRefs.filter((ref) => ref.ref.includes("t5-"))],
      extractor_attempt_refs: [], embedding_receipt_refs: [], expected_source_handles: rebuildOwner.value.source_handles,
      expected_source_groups: rebuildOwner.value.source_handles.map((handle) => [handle]),
      observed_source_handles: rebuildOwner.value.source_handles }, { extractor: false, embedding: false });
  const graph = report.samples.filter((sample) => sample.mode === "graph").map((sample) => sample.elapsed_ms).sort((a, b) => a - b);
  const hybrid = report.samples.filter((sample) => sample.mode === "hybrid").map((sample) => sample.elapsed_ms).sort((a, b) => a - b);
  if (graph.length !== 60 || hybrid.length !== 60 || graph[56]! > 500 || hybrid[56]! > 1_500) throw new Error("T4 qualification performance is not accepted");
  const acceptance: MemoryRecoveryAcceptance = { schema: "butler.memory-recovery-acceptance.v3",
    verification_generation_id: report.execution.generation_id,
    verification_source_inventory_hash: report.execution.qualification_source_inventory_hash,
    implementation_commit: input.implementationCommit, tool_contract_version: 2,
    extraction_version: "memory-extract-v2", embedding_version: report.execution.embedding_version,
    cases, performance: { prepared_graph_p95_ms: graph[56]!, prepared_hybrid_p95_ms: hybrid[56]!,
      graph_samples: graph.length, hybrid_samples: hybrid.length,
      report_ref: raw.performance_report.ref, report_sha256: raw.performance_report.sha256 } };
  const file = writeT4Evidence(input.outputDir, "acceptance.json", acceptance);
  const provenance = writeT4Evidence(input.outputDir, "qualification-provenance.json", {
    trace: { ref: copiedTrace.ref, sha256: copiedTrace.sha256 }, semantic_review: { ref: copiedReview.ref, sha256: copiedReview.sha256 },
    owner_evidence: ownerRefs.map(({ name, ref, sha256, facts_ref, facts_sha256 }) => ({ name, ref, sha256, facts_ref, facts_sha256 })),
    preserved_supporting_evidence: supportRefs.map(({ ref, sha256 }) => ({ ref, sha256 })),
    projected_cases: cases.map((item) => ({ id: item.id, trace_ref: item.trace_ref, trace_sha256: item.trace_sha256 })),
    performance_raw: { ref: resolve(input.performanceRawPath), sha256: sha(readFileSync(input.performanceRawPath, "utf8")) },
  });
  return { status: "qualification_artifact_prepared_pending_owner_validation", acceptance_path: file.path, acceptance_sha256: file.sha256,
    provenance_path: provenance.path, provenance_sha256: provenance.sha256 };
}

async function createT4EmbeddingRelay(path: string, upstreamPath: string) {
  let armed = false;
  let held: { client: import("node:net").Socket; chunks: Buffer[]; responseComplete: boolean;
    checkedRequest: Record<string, unknown> } | null = null;
  const server = createServer((client) => {
    const upstream = createConnection(upstreamPath);
    let requestBytes = "";
    let holdThisRequest = false;
    client.on("data", (chunk) => {
      requestBytes += chunk.toString();
      if (!holdThisRequest && armed && !held && requestBytes.includes("\n")) {
        try {
          const request = JSON.parse(requestBytes.slice(0, requestBytes.indexOf("\n"))) as Record<string, unknown>;
          if (request.checked === true && request.request_class === "background") {
            armed = false;
            holdThisRequest = true;
            held = { client, chunks: [], responseComplete: false, checkedRequest: request };
          }
        } catch (error) { client.destroy(error as Error); }
      }
    });
    client.pipe(upstream);
    upstream.on("data", (chunk) => {
      if (holdThisRequest && held?.client === client) held.chunks.push(Buffer.from(chunk));
      else client.write(chunk);
    });
    upstream.on("end", () => {
      if (holdThisRequest && held?.client === client) held.responseComplete = true;
      else client.end();
    });
    upstream.on("error", (error) => client.destroy(error));
    client.on("error", () => upstream.destroy());
    client.on("close", () => { if (!upstream.destroyed) upstream.destroy(); });
  });
  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolveReady(); });
  });
  return {
    arm() { if (armed || held) throw new Error("T4 embedding relay already armed"); armed = true; },
    heldRequest() { return held?.responseComplete && held.chunks.length ? held.checkedRequest : null; },
    heldResponseSha256() { return held?.responseComplete && held.chunks.length
      ? createHash("sha256").update(Buffer.concat(held.chunks)).digest("hex") : null; },
    release() { if (!held?.responseComplete || !held.chunks.length) throw new Error("T4 embedding relay has no complete held response");
      for (const chunk of held.chunks) held.client.write(chunk); held.client.end(); held = null; },
    async close() { if (held) { held.client.destroy(); held = null; }
      await new Promise<void>((resolveClose) => server.close(() => resolveClose())); },
  };
}

function t4DirectoryEvidence(root: string): Array<{ path: string; bytes: number; sha256: string }> {
  if (!existsSync(root)) return [];
  const rows: Array<{ path: string; bytes: number; sha256: string }> = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) rows.push({ path: path.slice(root.length + 1), bytes: stat.size,
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
    }
  };
  visit(root);
  return rows;
}

export async function runT4FullCliLifecycleChild(input: { root: string; acceptancePath: string; maxBuilds: number }) {
  if (existsSync(input.root)) throw new Error("T4 full CLI lifecycle requires a fresh separate root");
  const acceptance = JSON.parse(readFileSync(input.acceptancePath, "utf8")) as MemoryRecoveryAcceptance;
  if (acceptance.schema !== "butler.memory-recovery-acceptance.v3" ||
    acceptance.cases.some((item) => item.outcome !== "passed") || acceptance.performance.graph_samples !== 60 ||
    acceptance.performance.hybrid_samples !== 60) throw new Error("T4 full CLI requires completed qualification");
  if (!Number.isSafeInteger(input.maxBuilds) || input.maxBuilds <= 0) throw new Error("T4 full CLI requires an explicit build budget");
  const upstreamSocket = process.env.T4_UPSTREAM_EMBED_SOCKET?.trim();
  if (!upstreamSocket) throw new Error("T4 full CLI child requires its real upstream embedding socket");
  const relayPath = `${input.root}.embed-relay.sock`;
  const relay = await createT4EmbeddingRelay(relayPath, upstreamSocket);
  process.env.EMBED_SOCKET = relayPath;
  const cli = resolve("packages/butler-agent/src/agent/cognition/memory/scripts/consolidation-cycle.ts");
  const invoke = async (args: string[]) => {
    const result = Bun.spawn([process.execPath, "run", cli, ...args], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, BUTLER_DATA: input.root, EMBED_SOCKET: process.env.EMBED_SOCKET! } });
    const [exitCode, stdout, stderr] = await Promise.all([result.exited, new Response(result.stdout).text(), new Response(result.stderr).text()]);
    if (exitCode !== 0) throw new Error(`T4 full CLI failed: ${args.join(" ")}: ${stderr}`);
    return JSON.parse(stdout);
  };
  const runBuilds = async (generation: string, budget: { used: number }) => {
    const builds = [];
    while (budget.used < input.maxBuilds) {
      budget.used += 1;
      const build = await invoke(["--memory-rebuild", "build", "--generation", generation]);
      builds.push(build);
      if (!build.deadline_reached && Object.values(build.pending ?? {}).every((value) => value === 0) &&
        build.readiness && build.readiness.unaccounted === 0 &&
        [build.readiness.semantic, build.readiness.vectors, build.readiness.cache].every((stage: any) =>
          stage.pending === 0 && stage.failed === 0)) break;
    }
    const last = builds.at(-1);
    if (!last || last.deadline_reached || !Object.values(last.pending ?? {}).every((value) => value === 0) ||
      !last.readiness || last.readiness.unaccounted !== 0 ||
      [last.readiness.semantic, last.readiness.vectors, last.readiness.cache].some((stage: any) =>
        stage.pending !== 0 || stage.failed !== 0)) throw new Error("T4 full CLI build remained pending or unready");
    return builds;
  };
  const budget = { used: 0 };
  try {
  const initial = await runMemoryRecoveryDispatcherHarness(input.root, { afterReady: async ({ dispatch }) => {
    const prepared = await invoke(["--memory-rebuild", "prepare"]);
    const generation = prepared.generationId;
    if (!generation) throw new Error("T4 full CLI prepare returned no generation");
    const initialBuilds = await runBuilds(generation, budget);
    const delta = await dispatch(T4_CLI_DELTA);
    const refused = Bun.spawn([process.execPath, "run", cli, "--memory-rebuild", "validate", "--generation", generation,
      "--acceptance", resolve(input.acceptancePath)], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, BUTLER_DATA: input.root, EMBED_SOCKET: process.env.EMBED_SOCKET! } });
    const [refusedCode, refusedError] = await Promise.all([refused.exited, new Response(refused.stderr).text()]);
    if (refusedCode === 0 || !refusedError.includes("memory_inventory_changed")) {
      throw new Error("T4 full CLI did not refuse the post-prepare source delta");
    }
    const catchupBuilds = await runBuilds(generation, budget);
    const validated = await invoke(["--memory-rebuild", "validate", "--generation", generation, "--acceptance", resolve(input.acceptancePath)]);
    const { advanceNextMemoryProjection, readActiveDescriptor } = await import(
      "../../packages/butler-agent/src/agent/cognition/memory/index.ts"
    );
    const { runServingGenerationCatchup } = await import(
      "../../packages/butler-agent/src/agent/cognition/memory/scripts/phases/catchup.ts"
    );
    const oldDescriptor = readActiveDescriptor(input.root);
    await runServingGenerationCatchup({ butlerData: input.root, limit: 256, signal: AbortSignal.timeout(30_000) });
    const oldGraphPath = join(input.root, "cognition/memory/generations", oldDescriptor.generation_id, "graph.sqlite");
    for (let ordinal = 0; ordinal < 8 && !t4VectorUnitStates(oldGraphPath).some((unit) => unit.state === "pending"); ordinal += 1) {
      await advanceNextMemoryProjection({ context: { butlerData: input.root,
        target: { kind: "active", expected_generation: oldDescriptor.generation_id },
        signal: AbortSignal.timeout(30_000), deadlineAt: Date.now() + 30_000, waitClass: "background" } });
    }
    const pendingUnit = t4VectorUnitStates(oldGraphPath).find((unit) => unit.state === "pending");
    if (!pendingUnit) throw new Error("T4 full CLI old generation never reached a pending vector unit");
    relay.arm();
    const lateDeadline = Date.now() + 30_000;
    let lateAdvance: Promise<{ progress: any; error: unknown }> | null = null;
    for (let ordinal = 0; ordinal < 8 && !relay.heldRequest() && Date.now() < lateDeadline; ordinal += 1) {
      const candidate = advanceNextMemoryProjection({ context: { butlerData: input.root,
        target: { kind: "active", expected_generation: oldDescriptor.generation_id },
        signal: AbortSignal.timeout(Math.max(1, lateDeadline - Date.now())), deadlineAt: lateDeadline,
        waitClass: "background" } }).then((progress) => ({ progress, error: null as unknown }),
          (error) => ({ progress: null, error }));
      while (!relay.heldRequest() && Date.now() < lateDeadline) {
        const state = await Promise.race([candidate.then(() => "settled" as const), Bun.sleep(10).then(() => "waiting" as const)]);
        if (state === "settled") break;
      }
      if (relay.heldRequest()) lateAdvance = candidate;
      else {
        const outcome = await candidate;
        if (outcome.error) throw outcome.error;
      }
    }
    const heldRequest = relay.heldRequest();
    const heldResponseSha256 = relay.heldResponseSha256();
    if (!heldRequest || !heldResponseSha256 || !lateAdvance) {
      throw new Error("T4 full CLI relay did not observe a complete real in-flight vector response");
    }
    const runningBatch = t4VectorUnitStates(oldGraphPath).filter((unit) => unit.state === "running" &&
      unit.owner_nonce && unit.receipt_json === null);
    if (!runningBatch.length || !Array.isArray(heldRequest.texts) ||
      t4Json([...heldRequest.texts].sort()) !== t4Json(runningBatch.map((unit) => unit.projection_text).sort()) ||
      heldRequest.deadline_at !== lateDeadline) {
      throw new Error("T4 full CLI held response is not bound to its actual claimed vector batch/deadline");
    }
    const beforeLate = runningBatch.map((unit) => ({ ...unit }));
    const lanceBefore = t4DirectoryEvidence(join(dirname(oldGraphPath), "butler.lance"));
    const activated = await invoke(["--memory-rebuild", "activate", "--generation", generation]);
    relay.release();
    const lateOutcome = await lateAdvance;
    if (lateOutcome.error) throw lateOutcome.error;
    const lateProgress = lateOutcome.progress;
    const afterLate = beforeLate.map((before) => t4VectorUnitStates(oldGraphPath)
      .find((unit) => unit.unit_id === before.unit_id));
    const lanceAfter = t4DirectoryEvidence(join(dirname(oldGraphPath), "butler.lance"));
    if (afterLate.some((unit, index) => !unit || t4Json(unit) !== t4Json(beforeLate[index])) ||
      t4Json(lanceAfter) !== t4Json(lanceBefore) || readActiveDescriptor(input.root).generation_id !== generation) {
      throw new Error("T4 full CLI late old-generation vector completion committed after activation");
    }
    if (activated.descriptor?.schema !== "butler.memory-active-generation.v2" ||
      activated.descriptor.generation_id !== generation ||
      activated.descriptor.previous_generation_id !== oldDescriptor.generation_id) {
      throw new Error("T4 full CLI activation did not retain the old/current descriptor relationship");
    }
    const current = await invoke(["--memory-rebuild", "inspect", "--generation", generation]);
    if (current.result?.manifest?.state !== "active") throw new Error("T4 full CLI current generation inspection changed");
    const next = await invoke(["--memory-rebuild", "prepare"]);
    if (!next.generationId || next.generationId === generation) throw new Error("T4 full CLI NEXT generation was not distinct");
    const nextInspection = await invoke(["--memory-rebuild", "inspect", "--generation", next.generationId]);
    if (nextInspection.result?.manifest?.state !== "building") throw new Error("T4 full CLI NEXT generation was not preserved as building");
    const rolledBack = await invoke(["--memory-rebuild", "rollback", "--generation", generation]);
    const rollbackDescriptor = readActiveDescriptor(input.root);
    const rollbackPreserved = beforeLate.map((before) => t4VectorUnitStates(oldGraphPath)
      .find((unit) => unit.unit_id === before.unit_id));
    const nextAfterRollback = await invoke(["--memory-rebuild", "inspect", "--generation", next.generationId]);
    const pendingObserved = rollbackPreserved.some((unit) => unit?.state === "running" || unit?.state === "pending") ||
      Boolean(rolledBack.catchup && (!rolledBack.catchup.available || rolledBack.catchup.scanned >= 256));
    if (rollbackDescriptor.schema !== oldDescriptor.schema || rollbackDescriptor.generation_id !== oldDescriptor.generation_id ||
      rollbackDescriptor.previous_generation_id !== generation || rollbackDescriptor.projection_mode !== oldDescriptor.projection_mode ||
      afterLate.some((unit, index) => !unit || t4Json(unit) !== t4Json(rollbackPreserved[index])) ||
      nextAfterRollback.result?.manifest?.state !== "building" || rolledBack.rollback_pending !== pendingObserved ||
      !rolledBack.target_status) {
      throw new Error("T4 full CLI rollback did not preserve its actual old/NEXT pending state");
    }
    return { prepared, initial_builds: initialBuilds, delta, delta_refusal: "memory_inventory_changed",
      catchup_builds: catchupBuilds, validated, activated, late_progress: lateProgress,
      late_vector: { held_request_sha256: sha(t4Json(heldRequest)), held_response_sha256: heldResponseSha256,
        before: beforeLate, after: afterLate, lance_before: lanceBefore, lance_after: lanceAfter },
      current, next, next_inspection: nextInspection, next_after_rollback: nextAfterRollback, rolled_back: rolledBack };
  } });
  return { status: "completed", initial };
  } finally { await relay.close(); }
}

export function runT4FullCliLifecycle(input: { root: string; acceptancePath: string; maxBuilds: number }) {
  if (existsSync(input.root)) throw new Error("T4 full CLI parent requires a fresh separate root");
  const socketPath = process.env.EMBED_SOCKET?.trim();
  if (!socketPath) throw new Error("T4 full CLI parent requires an allocated embedding socket before child import");
  const relayPath = `${resolve(input.root)}.embed-relay.sock`;
  const result = Bun.spawnSync([process.execPath, "run", resolve(process.argv[1]!), "--t4-full-cli-child",
    "--data-root", resolve(input.root), "--acceptance", resolve(input.acceptancePath), "--max-builds", String(input.maxBuilds)], {
    cwd: process.cwd(), env: { ...process.env, BUTLER_DATA: resolve(input.root), EMBED_SOCKET: relayPath,
      T4_UPSTREAM_EMBED_SOCKET: socketPath },
  });
  if (result.exitCode !== 0) throw new Error(`T4 full CLI child failed: ${result.stderr.toString()}`);
  return JSON.parse(result.stdout.toString());
}

async function runT4ActualPhaseBranch(input: {
  butlerData: string; graphPath: string; generationId: string; appUrl: string;
  baseline: T4ClosedBaseline; observer: ReturnType<typeof createT4PhaseObserver>;
  dispatch: (text: string, admission: T4AppAdmission,
    budgets?: { poll: LivePollBudget; ingress: IngressPollBudget }) => Promise<DeliveredTarget>;
  pollBudget: LivePollBudget; ingressBudget: IngressPollBudget;
  terminalReplays: number;
  performance?: T4PerformanceOptions;
  q1Resume?: T4Q1Resume;
}) {
  const startedAt = new Date().toISOString();
  const tracePath = `${input.butlerData}/memory-t4-resume-trace.json`;
  const trace: Record<string, unknown> = { schema: "butler.memory.t4-resume-trace.v1",
    started_at: startedAt, generation_id: input.generationId,
    status: "running", temporal_binding: t4KstWeek(Date.now()),
    source_sha256: sha(T4_AD1), question_sha256: sha(T4_Q1),
    arabic_question_sha256: sha(T4_ARABIC_Q), model_round_driver: "actual_provider",
    preserved_actual01_failure: input.baseline.resume.preserved_failure,
    preserved_ad1_observation: input.baseline.resume.preserved_observation,
    terminal_replays: input.terminalReplays };
  const save = () => writeFileSync(tracePath, JSON.stringify(trace, null, 2));
  save();
  try {
    const ad1 = await readDeliveredTarget(input.appUrl, input.baseline.resume.ad1, input.butlerData,
      { claimed: 0, handled: 0, failed: 0, interrupted: 0 }, 0);
    if (!ad1 || ad1.conversationSessionId !== input.baseline.resume.ad1.conversationSessionId ||
      ad1.conversationTurnId !== input.baseline.resume.ad1.conversationTurnId ||
      ad1.conversationRequestMessageId !== input.baseline.resume.ad1.conversationRequestMessageId ||
      ad1.conversationAssistantMessageId !== input.baseline.resume.ad1.conversationAssistantMessageId) {
      throw new Error("T4 preserved AD1 App/canonical delivery changed");
    }
    const ad1Journal = readT4NativeJournal(input.butlerData, [ad1.turnId]);
    const preservedRounds = (input.baseline.resume.preserved_observation as any).observations ?? [];
    const preservedRound = preservedRounds[0];
    const acceptedRound = ad1Journal.rounds.find((row) => row.turn_id === ad1.turnId &&
      row.round_id === preservedRound?.round_id && row.route_digest === preservedRound?.route_context?.routeDigest &&
      row.candidate_index === preservedRound?.route_context?.cursor && row.model_ref === preservedRound?.model);
    const acceptedResponse = acceptedRound ? JSON.parse(acceptedRound.normalized_response_json) : null;
    if (!acceptedResponse || acceptedResponse.text !== preservedRound.text ||
      t4Json(acceptedResponse.toolCalls) !== t4Json(preservedRound.tool_calls)) {
      throw new Error("T4 preserved AD1 accepted provider round changed");
    }
    trace.ad1 = ad1;
    save();
    assertT4OldPins(input.graphPath, input.baseline);
    const projected = new Database(input.graphPath, { readonly: true });
    try {
      const job = projected.query<any, [string]>(`SELECT source_state,semantic_graph_state,
        episode_vectors_state,node_vectors_state,hot_cache_state,next_stage
        FROM memory_projection_jobs WHERE job_id=?`).get(input.baseline.resume.ad1_job_id);
      if (!job || JSON.parse(job.source_state).state !== "complete" ||
        JSON.parse(job.semantic_graph_state).state !== "complete" ||
        [job.episode_vectors_state, job.node_vectors_state, job.hot_cache_state]
          .some((state) => JSON.parse(state).state !== "complete")) {
        throw new Error("T4 preserved AD1 is no longer fully projected");
      }
    } finally { projected.close(); }
    if (ad1.conversationSessionId === input.baseline.general_session_id) throw new Error("T4 AD1 did not create a distinct canonical session");
    if (t4KstWeek(Date.now()).date_kst !== input.baseline.date_kst) throw new Error("T4 date changed before question ingress");
    let question: DeliveredTarget;
    let questionIngress: DeliveredTarget;
    if (input.q1Resume) {
      question = input.q1Resume.trace.question as DeliveredTarget;
      questionIngress = (question.originalDelivery ?? question) as DeliveredTarget;
      trace.question = question;
      trace.native_journal = input.q1Resume.trace.native_journal;
      trace.question_lineage_turns = input.q1Resume.trace.question_lineage_turns;
      trace.recall_observation = input.q1Resume.trace.recall_observation;
      trace.q1_stage_inventory = input.q1Resume.trace.q1_stage_inventory;
      trace.q1_provenance = { mode: "accepted_phase_reuse", implementation_commit: input.q1Resume.implementationCommit,
        prior_trace_status: input.q1Resume.trace.status, review_ref: input.q1Resume.reviewPath,
        review_sha256: input.q1Resume.reviewSha256, trace_ref: input.q1Resume.tracePath,
        trace_sha256: input.q1Resume.traceSha256, observation_ref: input.q1Resume.observationPath,
        observation_sha256: input.q1Resume.observationSha256 };
      if (input.performance) {
        for (const item of t4StageEvidenceRefs(input.q1Resume.trace.q1_stage_inventory as Record<string, any>)) {
          const copied = copyT4Evidence(input.performance.artifactDir, join(input.q1Resume.stageEvidenceRoot, item.ref), item.ref);
          if (copied.sha256 !== item.sha256) throw new Error("T4 accepted Q1 stage copy changed");
        }
        copyT4Evidence(input.performance.artifactDir, input.q1Resume.tracePath, "historical-q1/memory-t4-resume-trace.json");
        copyT4Evidence(input.performance.artifactDir, input.q1Resume.observationPath, "historical-q1/memory-t4-resume-observation.json");
        copyT4Evidence(input.performance.artifactDir, input.q1Resume.reviewPath, "historical-q1/root-q1-semantic-review.json");
      }
      save();
    } else {
      const questionChat = await createT4EmptyChat(input.appUrl);
      if (questionChat === ad1.chatId) throw new Error("T4 question reused the source chat");
      input.observer.begin("Q1");
      question = await input.dispatch(T4_Q1, { chatId: questionChat, model: "openai/gpt-5.5",
        reasoningEffort: "medium", awaitT4FinalSynthesis: true });
      input.observer.end();
      trace.question = question;
      if (question.delegatedTerminalStatus && question.delegatedTerminalStatus !== "success") {
        throw new Error(`T4 delegated Q1 ended with ${question.delegatedTerminalStatus}`);
      }
      questionIngress = question.originalDelivery ?? question;
      const lineageTurnIds = t4LineageTurnIds(input.butlerData, questionIngress.turnId);
      const journal = readT4NativeJournal(input.butlerData, lineageTurnIds);
      trace.native_journal = journal;
      trace.question_lineage_turns = [...lineageTurnIds];
      save();
      if ([ad1.conversationSessionId, input.baseline.general_session_id].includes(question.conversationSessionId)) {
        throw new Error("T4 question canonical session is not distinct from both past sessions");
      }
      for (const name of ["recall_memory", "query_memory", "list_conversation_sessions", "read_conversation_session"]) {
        const tool = input.observer.seenTools.get(name) as { toolContractVersion?: number } | undefined;
        if (!tool || tool.toolContractVersion !== 2) throw new Error("T4 actual model did not receive the four v2 memory tools");
      }
      trace.recall_observation = verifyT4ObservedRecall({ calls: input.observer.q1Calls.filter((call) => call.phase === "Q1"), journal, observations: input.observer.observations,
        baseline: input.baseline, ad1, question: questionIngress, graphPath: input.graphPath, generationId: input.generationId,
        lineageTurnIds });
      if (input.performance) trace.q1_stage_inventory = await writeT4PublicStageInventory(
        input.butlerData, input.performance.artifactDir, "q1",
      );
    }

    const arabicChat = await createT4EmptyChat(input.appUrl);
    if ([question.chatId, ad1.chatId].includes(arabicChat)) throw new Error("T4 Arabic question reused an earlier chat");
    let restoreCache: (() => Record<string, unknown>) | null = null;
    let arabic: DeliveredTarget;
    try {
      if (input.q1Resume) {
        if (!input.performance) throw new Error("T4 Q1 remainder requires an isolated evidence directory");
        const cachePath = join(dirname(input.graphPath), "hot", "cache.md");
        const cacheBytes = readFileSync(cachePath);
        const evidence = join(input.performance.artifactDir, "cold-cache", "original-cache.md");
        const withheld = join(input.performance.artifactDir, "cold-cache", "withheld-live-cache.md");
        if (existsSync(evidence) || existsSync(withheld)) throw new Error("T4 cold-cache evidence destination already exists");
        mkdirSync(dirname(evidence), { recursive: true, mode: 0o700 });
        writeFileSync(evidence, cacheBytes, { mode: 0o600 });
        const before = readT4HotCacheStates(input.graphPath);
        renameSync(cachePath, withheld);
        restoreCache = () => {
          if (existsSync(cachePath)) throw new Error("T4 cache changed while the original was isolated");
          renameSync(withheld, cachePath);
          const restored = readFileSync(cachePath);
          if (!restored.equals(cacheBytes)) throw new Error("T4 isolated cache was not restored byte-for-byte");
          const after = readT4HotCacheStates(input.graphPath);
          if (t4Json(after) !== t4Json(before)) throw new Error("T4 cache owner state changed during Arabic isolation");
          return { restored: true, sha256: createHash("sha256").update(restored).digest("hex"), after };
        };
        trace.arabic_cache_isolation = { cache_path: cachePath, evidence_ref: "cold-cache/original-cache.md",
          sha256: createHash("sha256").update(cacheBytes).digest("hex"), bytes: cacheBytes.byteLength, before };
        save();
      }
      input.observer.begin("ARABIC");
      arabic = await input.dispatch(T4_ARABIC_Q, { chatId: arabicChat, model: "openai/gpt-5.5",
        reasoningEffort: "medium", awaitT4FinalSynthesis: true });
    } finally {
      input.observer.end();
      if (restoreCache) trace.arabic_cache_restore = restoreCache();
      save();
    }
    trace.arabic_question = arabic;
    if (arabic.delegatedTerminalStatus && arabic.delegatedTerminalStatus !== "success") {
      throw new Error(`T4 delegated Arabic question ended with ${arabic.delegatedTerminalStatus}`);
    }
    const arabicIngress = arabic.originalDelivery ?? arabic;
    if ([question.conversationSessionId, ad1.conversationSessionId,
      input.baseline.general_session_id].includes(arabic.conversationSessionId)) {
      throw new Error("T4 Arabic question canonical session is not distinct from prior sessions");
    }
    const arabicOriginalTurnId = arabicIngress.turnId;
    const arabicLineageTurnIds = t4LineageTurnIds(input.butlerData, arabicOriginalTurnId);
    const arabicJournal = readT4NativeJournal(input.butlerData, arabicLineageTurnIds);
    trace.arabic_native_journal = arabicJournal;
    trace.arabic_question_lineage_turns = [...arabicLineageTurnIds];
    if (input.q1Resume) trace.arabic_cold_prompt = assertT4ColdArabicPromptOmission({
      observations: input.observer.observations, journal: arabicJournal,
      lineageTurnIds: arabicLineageTurnIds,
    });
    save();
    trace.arabic_evidence = verifyT4ArabicEvidence({
      calls: input.observer.q1Calls.filter((call) => call.phase === "ARABIC"),
      journal: arabicJournal, observations: input.observer.observations, root: input.butlerData,
      graphPath: input.graphPath, baseline: input.baseline, question: arabicIngress,
      lineageTurnIds: arabicLineageTurnIds,
    });
    if (input.performance) trace.arabic_stage_inventory = await writeT4PublicStageInventory(
      input.butlerData, input.performance.artifactDir, "arabic",
    );
    if (input.performance) {
      trace.performance = await runT4PerformancePhase({ butlerData: input.butlerData,
        graphPath: input.graphPath, generationId: input.generationId, appUrl: input.appUrl,
        runtime: arabicIngress, options: input.performance, observer: input.observer, dispatch: input.dispatch,
        pollBudget: input.pollBudget, ingressBudget: input.ingressBudget });
      save();
    }
    trace.preservation = assertT4OldPins(input.graphPath, input.baseline, Boolean(input.performance));
    trace.final_source_state = readAcceptedCorpusState(input.graphPath);
    trace.projection_polls = input.pollBudget.calls;
    trace.ingress_polls = input.ingressBudget.calls;
    trace.status = "observed_pending_root_semantic_review";
    trace.semantic_review_required = "Check both actual final answers against the verified dates and full original sources, including the Japanese red-ball correction; no fixed wording or synthetic model conclusion is used.";
    trace.finished_at = new Date().toISOString();
    save();
    return { status: trace.status, trace_path: tracePath, trace_sha256: sha(readFileSync(tracePath, "utf8")),
      model_round_driver: "actual_provider", phase_dispatch_admissions: input.observer.dispatches,
      logical_rounds: { AD1: input.observer.rounds.AD1.size, Q1: input.observer.rounds.Q1.size,
        ARABIC: input.observer.rounds.ARABIC.size },
      raw_personal_text_included: false };
  } catch (error) {
    input.observer.end();
    input.observer.save();
    trace.status = "failed";
    trace.finished_at = new Date().toISOString();
    trace.failure = error instanceof Error ? error.message : "unknown failure";
    save();
    throw error;
  }
}

async function sendAndDispatch(
  url: string,
  text: string,
  dispatcher: BtccInboundDispatcher,
  dependencies: Pick<
    BtccInboundDispatchOptions,
    "queue" | "server" | "store" | "deliveryGuard"
  >,
  memoryBudget: LivePollBudget = {
    calls: 0,
    maxCalls: Number.POSITIVE_INFINITY,
    deadlineAt: Number.POSITIVE_INFINITY,
  },
  options: {
    chatId?: string;
    model?: string;
    reasoningEffort?: "medium";
    butlerData?: string;
    ingressBudget?: IngressPollBudget;
    resume?: AppTarget;
    onTarget?: (target: AppTarget) => void;
    operationError?: () => Error | null;
    syncProjection?: () => Promise<void>;
    awaitT4FinalSynthesis?: boolean;
  } = {},
): Promise<DeliveredTarget> {
  assertLiveWallBudget(memoryBudget);
  const target = options.resume ?? (await admitAppTarget(url, text, undefined, options));
  if (
    target.requestText !== text ||
    target.admittedText !== text.trim() ||
    target.requestSha256 !== sha(text) ||
    target.admittedSha256 !== sha(text.trim())
  )
    throw new Error("App target request/admission byte binding mismatch");
  if (target.turnId) options.onTarget?.(target);
  const ingress = options.ingressBudget ?? {
    calls: 0,
    maxCalls: Number.POSITIVE_INFINITY,
    deadlineAt: Math.min(Date.now() + 10_000, memoryBudget.deadlineAt),
  };
  let lastDispatch = { claimed: 0, handled: 0, failed: 0, interrupted: 0 };
  let unrelatedHandled = 0;
  while (ingress.calls < ingress.maxCalls && Date.now() < ingress.deadlineAt) {
    ingress.calls += 1;
    const observed = await readAppTarget(url, target);
    if (observed.message && observed.turn) {
      const observedMessageId = String(observed.message.id);
      const observedTurnId = String(observed.turn.id);
      if (
        (target.messageId && target.messageId !== observedMessageId) ||
        (target.turnId && target.turnId !== observedTurnId)
      )
        throw new Error("App target identity changed after admission");
      target.messageId = observedMessageId;
      target.turnId = observedTurnId;
      options.onTarget?.(target);
    }
    if (options.awaitT4FinalSynthesis && target.turnId) {
      assertT4PendingLineage(
        options.butlerData ?? process.env.BUTLER_DATA ?? "",
        target.turnId,
      );
    }
    const summary = dispatcher.poll({ ...dependencies, limit: 1 });
    if (summary.claimed > 0) await dispatcher.waitForIdle();
    lastDispatch = {
      claimed: summary.claimed,
      handled: summary.handled,
      failed: summary.failed,
      interrupted: summary.interrupted,
    };
    if (summary.failed > 0 || summary.interrupted > 0)
      throw new Error(
        `App target dispatch failed: ${JSON.stringify(lastDispatch)}`,
      );
    const operationError = options.operationError?.();
    if (operationError) throw operationError;
    await options.syncProjection?.();
    assertLiveWallBudget(memoryBudget);
    const delivered = await readDeliveredTarget(
      url,
      target,
      options.butlerData ?? process.env.BUTLER_DATA ?? "",
      lastDispatch,
      unrelatedHandled,
    );
    if (delivered) {
      if (!options.awaitT4FinalSynthesis) return delivered;
      const final = await readT4FinalSynthesis(
        options.butlerData ?? process.env.BUTLER_DATA ?? "",
        target,
        delivered,
        lastDispatch,
        unrelatedHandled,
      );
      if (final) return final;
    }
    if (summary.handled > 0) unrelatedHandled += summary.handled;
    const terminal = await readTargetTerminalState(url, target);
    if (terminal)
      throw new Error(
        `App target ${terminal.state}: ${terminal.safeErrorCode ?? "unknown"}`,
      );
    await Bun.sleep(25);
  }
  throw new Error(
    `App target pending timeout: ${JSON.stringify({ message_id: target.messageId, turn_id: target.turnId, queue_id: target.queueId, ingress_polls: ingress.calls, last_dispatch: lastDispatch })}`,
  );
}

async function admitAppTarget(
  url: string,
  text: string,
  clientMessageId?: string,
  options: { chatId?: string; model?: string; reasoningEffort?: "medium" } = {},
): Promise<AppTarget> {
  const response = await fetch(`${url}messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    keepalive: false,
    body: JSON.stringify({
      chat_id: options.chatId ?? "general",
      text,
      ...(options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
      ...(clientMessageId ? { client_message_id: clientMessageId } : {}),
    }),
  });
  if (response.status !== 202)
    throw new Error(`App message ingress failed: ${response.status}`);
  const envelope = (await response.json()) as {
    protocol_version?: string;
    data?: any;
  };
  const data = envelope.data;
  if (
    envelope.protocol_version !== "butler.app.v1" ||
    !data ||
    typeof data !== "object"
  )
    throw new Error("App message ingress returned an invalid envelope");
  const admitted = data.accepted?.text ?? data.queued?.text;
  if (typeof admitted !== "string" || admitted !== text.trim())
    throw new Error("App message ingress did not preserve the admitted text");
  const messageId =
    typeof data.accepted?.id === "string"
      ? data.accepted.id
      : typeof data.queued?.dispatched_message_id === "string"
        ? data.queued.dispatched_message_id
        : null;
  const turnId =
    typeof data.turn?.id === "string"
      ? data.turn.id
      : typeof data.accepted?.turn_id === "string"
        ? data.accepted.turn_id
        : typeof data.queued?.turn_id === "string"
          ? data.queued.turn_id
          : null;
  if (data.accepted && data.turn && data.accepted.turn_id !== data.turn.id)
    throw new Error("App accepted message/turn identity mismatch");
  if (
    data.turn?.user_message_id &&
    messageId &&
    data.turn.user_message_id !== messageId
  )
    throw new Error("App turn/request identity mismatch");
  const queueId = typeof data.queued?.id === "string" ? data.queued.id : null;
  if (!messageId && !queueId)
    throw new Error("App ingress returned no target identity");
  const returnedChatId = data.accepted?.chat_id ?? data.queued?.chat_id ?? data.turn?.chat_id;
  if (options.chatId && returnedChatId !== options.chatId) {
    throw new Error("App ingress changed the requested new chat identity");
  }
  return {
    chatId:
      data.accepted?.chat_id ??
      data.queued?.chat_id ??
      data.turn?.chat_id ??
      "general",
    messageId,
    turnId,
    queueId,
    clientMessageId:
      typeof data.queued?.client_message_id === "string"
        ? data.queued.client_message_id
        : messageId,
    requestText: text,
    admittedText: admitted,
    requestBytes: Buffer.byteLength(text),
    requestSha256: sha(text),
    admittedBytes: Buffer.byteLength(admitted),
    admittedSha256: sha(admitted),
  };
}

async function readDeliveredTarget(
  url: string,
  original: AppTarget,
  butlerData: string,
  lastDispatch: {
    claimed: number;
    handled: number;
    failed: number;
    interrupted: number;
  },
  unrelatedHandled: number,
): Promise<DeliveredTarget | null> {
  const app = await readAppTarget(url, original);
  if (!app.message || !app.turn || app.turn.state !== "delivered") return null;
  const request = app.message;
  const assistant = app.messages.find(
    (item: any) =>
      item.turn_id === app.turn.id &&
      item.role === "assistant" &&
      item.status === "delivered",
  );
  if (!assistant || request.text !== original.admittedText) return null;
  if (!butlerData.trim())
    throw new Error("canonical target reader requires BUTLER_DATA");
  const [
    { ConversationProjectionReaderStore },
    { conversationMessageText },
    { sessionHintForRow },
  ] =
    await Promise.all([
      import("../../packages/butler-agent/src/agent/conversation/projection-reader-store.ts"),
      import("../../packages/butler-agent/src/agent/conversation/message-text.ts"),
      import("../../packages/butler-agent/src/gateways/app/domain/sessions/session-read-model.ts"),
    ]);
  const canonical = new ConversationProjectionReaderStore(
    `${butlerData}/runtime/conversation-store.sqlite`,
  );
  try {
    const turn = canonical.readTurn(app.turn.id);
    const outcome = canonical.readTurnOutcome(app.turn.id);
    const binding = turn
      ? canonical.getGatewayBindingForConversation(turn.session_id, "app")
      : null;
    const canonicalRequest = outcome?.request_message_id
      ? canonical.readMessageById(outcome.request_message_id)
      : null;
    const canonicalAssistant = outcome?.public_assistant_message_id
      ? canonical.readMessageById(outcome.public_assistant_message_id)
      : null;
    if (
      !turn ||
      turn.id !== app.turn.id ||
      turn.status !== "complete" ||
      !outcome ||
      outcome.outcome !== "delivered" ||
      outcome.session_id !== turn.session_id ||
      outcome.turn_id !== turn.id ||
      !binding ||
      binding.conversation_session_id !== turn.session_id ||
      binding.external_session_id !== sessionHintForRow(original.chatId) ||
      outcome.request_message_id !== canonicalRequest?.id ||
      outcome.public_assistant_message_id !== canonicalAssistant?.id ||
      canonicalRequest?.session_id !== turn.session_id ||
      canonicalRequest.turn_id !== turn.id ||
      canonicalRequest?.role !== "user" ||
      canonicalRequest.origin_kind !== "user_input" ||
      canonicalRequest.status !== "complete" ||
      canonicalRequest.source_gateway !== "app" ||
      canonicalRequest.source_ref !== `app:${request.id}` ||
      canonicalAssistant?.session_id !== turn.session_id ||
      canonicalAssistant.turn_id !== turn.id ||
      canonicalAssistant?.role !== "assistant" ||
      canonicalAssistant.origin_kind !== "assistant_public" ||
      canonicalAssistant.status !== "complete" ||
      (request.conversation_session_id != null &&
        request.conversation_session_id !== turn.session_id) ||
      (request.conversation_turn_id != null &&
        request.conversation_turn_id !== turn.id) ||
      (request.conversation_message_id != null &&
        request.conversation_message_id !== canonicalRequest?.id) ||
      (assistant.conversation_session_id != null &&
        assistant.conversation_session_id !== turn.session_id) ||
      (assistant.conversation_turn_id != null &&
        assistant.conversation_turn_id !== turn.id) ||
      (assistant.conversation_message_id != null &&
        assistant.conversation_message_id !== canonicalAssistant?.id) ||
      conversationMessageText(canonicalRequest) !== original.admittedText ||
      conversationMessageText(canonicalAssistant) !== assistant.text
    )
      throw new Error(
        "App target did not bind to its delivered canonical outcome",
      );
    return {
      ...original,
      messageId: request.id,
      turnId: app.turn.id,
      conversationSessionId: turn.session_id,
      conversationTurnId: turn.id,
      conversationRequestMessageId: canonicalRequest.id,
      conversationAssistantMessageId: canonicalAssistant.id,
      assistantText: assistant.text,
      lastDispatch,
      unrelatedHandled,
    };
  } finally {
    canonical.close();
  }
}

async function readT4FinalSynthesis(
  root: string,
  original: AppTarget,
  originalDelivery: DeliveredTarget,
  lastDispatch: DeliveredTarget["lastDispatch"],
  unrelatedHandled: number,
): Promise<DeliveredTarget | null> {
  const btcc = new Database(join(root, "agent-runtime", "btcc.sqlite"), { readonly: true });
  const app = new Database(join(root, "app.sqlite"), { readonly: true });
  try {
    const lineage = t4LineageTurnIds(root, originalDelivery.turnId);
    const relations = btcc.query<any, []>(
      "SELECT relation_id,parent_session_id,parent_turn_id,child_session_id FROM btcc_session_relations ORDER BY ordinal",
    ).all().filter((row) => lineage.has(row.parent_turn_id));
    if (relations.length === 0) return originalDelivery;
    const results = btcc.query<any, []>(
      "SELECT relation_id,result_id,child_turn_id,status FROM btcc_steward_results",
    ).all();
    if (relations.some((relation) => {
      const result = results.find((item) => item.relation_id === relation.relation_id);
      return !result || !["success", "blocked", "failed", "cancelled"].includes(result.status);
    })) return null;
    const topRelations = relations.filter((relation) => relation.parent_turn_id === originalDelivery.turnId);
    if (topRelations.length === 0) throw new Error("T4 delegated lineage lost its original Q1 relation");
    const outbox = btcc.query<any, []>(`
      SELECT relation_id,result_id,parent_session_id,parent_turn_id,message_id,input_json,status,delivered_at
      FROM btcc_subsession_outbox ORDER BY created_at
    `).all();
    const candidates = app.query<any, []>(`
      SELECT t.rowid,t.id,t.chat_id,t.user_message_id,t.state,t.safe_error_code,t.execution_controls_json,
        request.text request_text,assistant.id assistant_id,assistant.text assistant_text
      FROM turns t JOIN messages request ON request.id=t.user_message_id
      LEFT JOIN messages assistant ON assistant.turn_id=t.id AND assistant.role='assistant' AND assistant.status='delivered'
      WHERE t.execution_controls_json IS NOT NULL
      ORDER BY t.rowid DESC
    `).all().flatMap((row) => {
      const synthesis = JSON.parse(row.execution_controls_json)?.subsession_result;
      for (const relation of topRelations) {
        const result = results.find((item) => item.relation_id === relation.relation_id);
        const delivered = outbox.find((item) => item.relation_id === relation.relation_id &&
          item.result_id === result?.result_id);
        if (!delivered || delivered.parent_session_id !== relation.parent_session_id ||
          delivered.status !== "delivered" || !delivered.delivered_at) continue;
        const parentInput = JSON.parse(delivered.input_json ?? "null");
        if (synthesis?.relation_id === relation.relation_id && synthesis?.result_id === result?.result_id &&
          delivered.parent_turn_id === parentInput?.parent_turn_id &&
          delivered.message_id === parentInput?.message_id &&
          parentInput?.relation_id === relation.relation_id && parentInput?.result_id === result?.result_id &&
          parentInput?.parent_session_id === delivered.parent_session_id &&
          parentInput?.parent_chat_id === original.chatId && parentInput?.text === row.request_text &&
          row.user_message_id === subsessionResultClientMessageId(relation.relation_id, result.result_id)) {
          return [{ ...row, parent_input: parentInput, terminal_status: result.status }];
        }
      }
      return [];
    });
    const terminalFailure = candidates.find((row) =>
      ["failed", "runtime_fault", "cancelled"].includes(row.state)
    );
    if (terminalFailure) {
      throw new Error(`T4 delegated synthesis ${terminalFailure.state}: ${terminalFailure.safe_error_code ?? terminalFailure.terminal_status}`);
    }
    const final = candidates.find((row) => row.state === "delivered" && row.assistant_id);
    if (!final || !lineage.has(final.id)) return null;
    if (readT4PendingInbound(root).length > 0) return null;
    const [{ ConversationProjectionReaderStore }, { conversationMessageText }] = await Promise.all([
      import("../../packages/butler-agent/src/agent/conversation/projection-reader-store.ts"),
      import("../../packages/butler-agent/src/agent/conversation/message-text.ts"),
    ]);
    const canonical = new ConversationProjectionReaderStore(
      join(root, "runtime", "conversation-store.sqlite"),
    );
    try {
      const turn = canonical.readTurn(final.id);
      const outcome = canonical.readTurnOutcome(final.id);
      const request = outcome?.request_message_id ? canonical.readMessageById(outcome.request_message_id) : null;
      const assistant = outcome?.public_assistant_message_id
        ? canonical.readMessageById(outcome.public_assistant_message_id)
        : null;
      const binding = turn ? canonical.getGatewayBindingForConversation(turn.session_id, "app") : null;
      if (!turn || turn.status !== "complete" || outcome?.outcome !== "delivered" ||
        request?.role !== "user" || request.origin_kind !== "internal_control" ||
        assistant?.role !== "assistant" || assistant.origin_kind !== "internal_control" ||
        binding?.external_session_id !== `butler/app-${original.chatId}` ||
        conversationMessageText(request) !== final.request_text ||
        conversationMessageText(assistant) !== final.assistant_text) {
        throw new Error("T4 final synthesis did not bind to its internal canonical outcome");
      }
      const internalTurns = [...lineage].filter((turnId) => turnId !== originalDelivery.turnId);
      const raw = new Database(join(root, "runtime", "conversation-store.sqlite"), { readonly: true });
      try {
        for (const turnId of internalTurns) {
          const rows = raw.query<{ origin_kind: string }, [string]>(
            "SELECT origin_kind FROM conversation_messages WHERE turn_id=? AND role IN ('user','assistant')",
          ).all(turnId);
          if (rows.length > 0 && rows.some((row) => row.origin_kind !== "internal_control")) {
            throw new Error("T4 delegated child or synthesis source was not internal_control");
          }
        }
      } finally { raw.close(); }
      return {
        chatId: final.chat_id,
        messageId: final.user_message_id,
        turnId: final.id,
        queueId: null,
        clientMessageId: final.user_message_id,
        requestText: final.parent_input.text,
        admittedText: final.request_text,
        requestBytes: Buffer.byteLength(final.parent_input.text),
        requestSha256: sha(final.parent_input.text),
        admittedBytes: Buffer.byteLength(final.request_text),
        admittedSha256: sha(final.request_text),
        conversationSessionId: turn.session_id,
        conversationTurnId: turn.id,
        conversationRequestMessageId: request.id,
        conversationAssistantMessageId: assistant.id,
        assistantText: final.assistant_text,
        lastDispatch,
        unrelatedHandled,
        originalDelivery,
        delegatedTerminalStatus: final.terminal_status,
      };
    } finally { canonical.close(); }
  } finally {
    app.close();
    btcc.close();
  }
}

async function readTargetTerminalState(
  url: string,
  target: AppTarget,
): Promise<{ state: string; safeErrorCode: string | null } | null> {
  const app = await readAppTarget(url, target);
  if (
    !app.turn ||
    !["failed", "runtime_fault", "cancelled"].includes(app.turn.state)
  )
    return null;
  return {
    state: app.turn.state,
    safeErrorCode: app.turn.safe_error_code ?? null,
  };
}

async function readAppTarget(
  url: string,
  target: AppTarget,
): Promise<{ message: any | null; turn: any | null; messages: any[] }> {
  const [messagesEnvelope, turnsEnvelope, queueEnvelope] = await Promise.all([
    fetchJson(`${url}messages?chat_id=${encodeURIComponent(target.chatId)}&cursor=0`),
    fetchJson(`${url}turns?chat_id=${encodeURIComponent(target.chatId)}&cursor=0`),
    target.queueId
      ? fetchJson(
        `${url}session-queue?session_id=${encodeURIComponent(target.chatId)}`,
      )
      : Promise.resolve(null),
  ]);
  const messages = Array.isArray(messagesEnvelope?.data?.messages)
    ? messagesEnvelope.data.messages
    : [];
  const turns = Array.isArray(turnsEnvelope?.data?.turns)
    ? turnsEnvelope.data.turns
    : [];
  const queued = Array.isArray(queueEnvelope?.data?.queued_messages)
    ? queueEnvelope.data.queued_messages.find(
        (item: any) => item.id === target.queueId,
      )
    : null;
  const messageId =
    target.messageId ??
    queued?.dispatched_message_id ??
    target.clientMessageId ??
    null;
  const message = messageId
    ? (messages.find((item: any) => item.id === messageId) ?? null)
    : null;
  const turnId = target.turnId ?? queued?.turn_id ?? message?.turn_id ?? null;
  return {
    messages,
    message,
    turn: turnId
      ? (turns.find((item: any) => item.id === turnId) ?? null)
      : null,
  };
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, { keepalive: false });
  if (!response.ok) {
    const body = await response.clone().json().catch(() => null) as any;
    const safeErrorCode =
      body?.error?.code ?? body?.data?.safe_error_code ?? "unknown";
    throw new Error(
      `App projection read failed: ${new URL(url).pathname} status=${response.status} safe_error_code=${safeErrorCode}`,
    );
  }
  return response.json();
}

async function requireProjectionPoll(
  butlerData: string,
  graphPath: string,
  expectedJobs: number,
  failedAtStart: Set<string>,
  poll: (input: { butlerData: string }) => Promise<{ action: string }>,
  budget: LivePollBudget,
) {
  const startedCalls = budget.calls;
  while (
    budget.calls < budget.maxCalls &&
    Date.now() < budget.deadlineAt &&
    (Number.isFinite(budget.maxCalls) || budget.calls - startedCalls < 64)
  ) {
    assertNoNewVectorFailure(graphPath, failedAtStart);
    const state = assertAllocatedProjectionState(graphPath, expectedJobs, undefined, budget.maxExtraLeaves);
    if (
      Number(state.jobs) === expectedJobs &&
      Number(state.pending) === 0 &&
      Number(state.complete) === Number(state.windows)
    )
      return budget.calls - startedCalls;
    if (
      state.next_attempt_at &&
      Date.parse(state.next_attempt_at) > Date.now()
    ) {
      const remaining = Math.max(0, budget.deadlineAt - Date.now());
      await Bun.sleep(
        Math.min(
          250,
          Date.parse(state.next_attempt_at) - Date.now(),
          remaining,
        ),
      );
      continue;
    }
    const result = await boundedLivePoll(poll, butlerData, budget);
    if (!["processed", "idle"].includes(result.action))
      throw new Error(
        `memory projection poll did not process: ${result.action}`,
      );
    assertNoNewVectorFailure(graphPath, failedAtStart);
  }
  throw new Error("memory projection exceeded bounded allocation");
}

function countActiveProjectionWindows(graphPath: string): number {
  const db = new Database(graphPath, { readonly: true });
  try {
    return Number(
      db
        .query<
          { n: number },
          []
        >("SELECT COUNT(*) n FROM memory_projection_windows WHERE state!='replaced'")
        .get()!.n,
    );
  } finally {
    db.close();
  }
}

function resolveBoundBGraphSources(
  graphPath: string,
  targets: DeliveredTarget[],
  expectedTargets: number,
): Array<{ sourceId: string; contentHash: string }> {
  if (targets.length !== expectedTargets) throw new Error("B target binding count mismatch");
  const db = new Database(graphPath, { readonly: true });
  try {
    return targets.flatMap((target) => {
      const rows = db.query<{ source_id: string; content_hash: string; byte_start: number; byte_end: number }, [string]>(
        "SELECT source_id,content_hash,byte_start,byte_end FROM memory_chunk_sources WHERE conversation_message_id=? ORDER BY byte_start,source_id",
      ).all(target.conversationRequestMessageId);
      let end = 0;
      if (!rows.length || rows.some((row) => {
        const invalid = row.content_hash !== target.admittedSha256 || row.byte_start !== end || row.byte_end <= row.byte_start;
        end = row.byte_end;
        return invalid;
      }) || end !== target.admittedBytes) throw new Error("B App/canonical/graph source span coverage mismatch");
      return rows.map((row) => ({ sourceId: row.source_id, contentHash: row.content_hash }));
    });
  } finally { db.close(); }
}

async function verifyLiveRecallPreconditions(input: {
  butlerData: string;
  graphPath: string;
  generationId: string;
  accepted: ReturnType<typeof readAcceptedCorpusState>;
  bSources: Array<{ sourceId: string; contentHash: string }>;
  preservedPlanCount: number;
  expectedJobs: number;
  maxExtraLeaves: number;
}): Promise<{
  asOf: string;
  trace: Record<string, unknown>;
}> {
  const descriptor = JSON.parse(
    readFileSync(
      `${input.butlerData}/cognition/memory/active-generation.json`,
      "utf8",
    ),
  );
  if (descriptor.generation_id !== input.generationId)
    throw new Error("generation changed before fixed recall");
  const manifest = JSON.parse(
    readFileSync(
      `${input.butlerData}/cognition/memory/generations/${input.generationId}/manifest.json`,
      "utf8",
    ),
  );
  if (!manifest.embedding?.version)
    throw new Error("measured embedding manifest missing before fixed recall");
  const db = new Database(input.graphPath, { readonly: true });
  let graph: {
    jobs: number;
    windows: number;
    complete: number;
    bSources: number;
    bPlans: number;
    laterMentions: number;
    s2SourceId: string;
    s2ObservedAt: string;
    s2EpisodeId: string;
    s2Revision: string;
    s2OwnerRevision: string;
    s2SourceRefsJson: string;
    s2VectorReceiptJson: string;
    bLatestObservedAt: string;
  };
  try {
    const preserved = readAcceptedCorpusState(input.graphPath);
    if (
      preserved.preservedSources !== 2 ||
      !preservesCompletedPlans(preserved.completedPlans, input.accepted.completedPlans)
    )
      throw new Error(
        "accepted LIVE03 plans or sources changed before fixed recall",
      );
    const state = db
      .query<{ jobs: number; windows: number; complete: number }, []>(
        `
      SELECT (SELECT COUNT(*) FROM memory_projection_jobs) jobs,COUNT(*) windows,SUM(state='complete') complete
      FROM memory_projection_windows WHERE state!='replaced'
    `,
      )
      .get()!;
    const s2 = db
      .query<
        {
          source_id: string;
          observed_at: string;
          episode_id: string;
          revision: string;
        },
        [string]
      >(
        `
      SELECT source_id,observed_at,episode_id,revision FROM memory_chunk_sources
      WHERE content_hash=? AND byte_end-byte_start=25 ORDER BY observed_at LIMIT 1
    `,
      )
      .get(sha(S2));
    if (!s2) throw new Error("preserved S2 source missing before fixed recall");
    const bSources = Number(
      db
        .query<{ n: number }, string[]>(
          `
      SELECT COUNT(DISTINCT source_id) n FROM memory_chunk_sources
      WHERE source_id IN (${input.bSources.map(() => "?").join(",")})
    `,
        )
        .get(...input.bSources.map((source) => source.sourceId))!.n,
    );
    const bPlans = Number(
      db
        .query<{ n: number }, string[]>(
          `
      SELECT COUNT(DISTINCT w.window_ref) n FROM memory_projection_windows w
      JOIN json_each(w.source_refs_json) refs ON true JOIN memory_chunk_sources s ON s.source_id=refs.value
      WHERE s.source_id IN (${input.bSources.map(() => "?").join(",")}) AND w.state='complete'
        AND w.normalized_plan_json IS NOT NULL AND w.provider_evidence_json IS NOT NULL
    `,
        )
        .get(...input.bSources.map((source) => source.sourceId))!.n,
    );
    const bLatestObservedAt =
      db
        .query<{ value: string }, string[]>(
          `
      SELECT MAX(observed_at) value FROM memory_chunk_sources
      WHERE source_id IN (${input.bSources.map(() => "?").join(",")})
    `,
        )
        .get(...input.bSources.map((source) => source.sourceId))?.value ?? "";
    const laterMentions = Number(
      db
        .query<{ n: number }, string[]>(
          `
      SELECT COUNT(*) n FROM (
        SELECT DISTINCT m.entity_id,m.source_id FROM entity_mentions m
        JOIN memory_chunk_sources source ON source.source_id=m.source_id
        WHERE source.observed_at>? AND source.source_id IN (${input.bSources.map(() => "?").join(",")})
      )
    `,
        )
        .get(
          s2.observed_at,
          ...input.bSources.map((source) => source.sourceId),
        )!.n,
    );
    const vectorUnit = db
      .query<
        { owner_revision: string; source_ids_json: string; receipt_json: string },
        [string, string, string, string]
      >(
        `
      SELECT u.owner_revision,u.source_ids_json,u.receipt_json
      FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id
      WHERE u.record_kind='episode' AND u.owner_id=? AND j.revision=? AND j.generation=? AND u.state='complete'
        AND EXISTS (SELECT 1 FROM json_each(u.source_ids_json) refs WHERE refs.value=?)
      ORDER BY u.unit_id LIMIT 1
    `,
      )
      .get(s2.episode_id, s2.revision, input.generationId, s2.source_id);
    if (!vectorUnit)
      throw new Error("current S2 vector unit missing before fixed recall");
    graph = {
      jobs: Number(state.jobs),
      windows: Number(state.windows),
      complete: Number(state.complete),
      bSources,
      bPlans,
      laterMentions,
      s2SourceId: s2.source_id,
      s2ObservedAt: s2.observed_at,
      s2EpisodeId: s2.episode_id,
      s2Revision: s2.revision,
      s2OwnerRevision: vectorUnit.owner_revision,
      s2SourceRefsJson: vectorUnit.source_ids_json,
      s2VectorReceiptJson: vectorUnit.receipt_json,
      bLatestObservedAt,
    };
  } finally {
    db.close();
  }
  if (
    graph.jobs !== input.expectedJobs ||
    graph.windows < input.expectedJobs || graph.windows > input.expectedJobs + input.maxExtraLeaves ||
    graph.complete !== graph.windows ||
    graph.bSources !== input.bSources.length ||
    graph.bPlans !== input.bSources.length ||
    graph.laterMentions < 250
  )
    throw new Error(
      `fixed recall corpus precondition failed: ${JSON.stringify({ jobs: graph.jobs, windows: graph.windows, complete: graph.complete, bSources: graph.bSources, bPlans: graph.bPlans, laterMentions: graph.laterMentions })}`,
    );
  const sourceRefs = JSON.parse(graph.s2SourceRefsJson) as string[];
  if (!sourceRefs.includes(graph.s2SourceId))
    throw new Error("S2 vector unit source receipt mismatch");
  const vectorReceipt = JSON.parse(graph.s2VectorReceiptJson);
  if (vectorReceipt?.generation !== input.generationId ||
    vectorReceipt.embedding_version !== manifest.embedding.version ||
    !Array.isArray(vectorReceipt.vector_keys) || vectorReceipt.vector_keys.length === 0 ||
    vectorReceipt.vector_keys.some((key: unknown) => typeof key !== "string" || !key) ||
    new Set(vectorReceipt.vector_keys).size !== vectorReceipt.vector_keys.length ||
    vectorReceipt.row_count !== vectorReceipt.vector_keys.length)
    throw new Error("S2 vector batch receipt mismatch");
  const lancedb = await import("@lancedb/lancedb");
  const connection = await lancedb.connect(
    `${input.butlerData}/cognition/memory/generations/${input.generationId}/butler.lance`,
  );
  const table = await connection.openTable("butler_memory");
  const vectorRows = (await table
    .query()
    .where(
      [
        `generation = ${lanceLiteral(input.generationId)}`,
        "record_kind = 'episode'",
        `owner_id = ${lanceLiteral(graph.s2EpisodeId)}`,
        `owner_revision = ${lanceLiteral(graph.s2OwnerRevision)}`,
        `source_revision = ${lanceLiteral(graph.s2Revision)}`,
        `embedding_version = ${lanceLiteral(manifest.embedding.version)}`,
      ].join(" AND "),
    )
    .select(["vector_key", "source_refs_json", "embedding_version"])
    .limit(5)
    .toArray()) as Array<{
    vector_key: string;
    source_refs_json: string;
    embedding_version: string;
  }>;
  if (
    vectorRows.length === 0 ||
    vectorRows.some(
      (row) =>
        row.embedding_version !== manifest.embedding.version ||
        row.source_refs_json !== graph.s2SourceRefsJson ||
        !vectorReceipt.vector_keys.includes(row.vector_key),
    )
  )
    throw new Error("current S2 Lance row receipt mismatch");
  const asOf = new Date().toISOString();
  if (
    !graph.bLatestObservedAt ||
    Date.parse(asOf) < Date.parse(graph.bLatestObservedAt)
  )
    throw new Error("fixed recall as_of predates B corpus");
  return {
    asOf,
    trace: {
      generation_id_sha256: sha(input.generationId),
      as_of: asOf,
      b_source_hashes: input.bSources.map((source) => source.contentHash),
      b_source_ids_sha256: input.bSources.map((source) => sha(source.sourceId)),
      b_latest_observed_at: graph.bLatestObservedAt,
      later_distinct_b_mentions: graph.laterMentions,
      projection_jobs: graph.jobs,
      completed_windows: graph.complete,
      s2_source_ref_sha256: sha(graph.s2SourceId),
      s2_source_hash: sha(S2),
      s2_source_observed_at: graph.s2ObservedAt,
      s2_revision_sha256: sha(graph.s2Revision),
      vector_version: manifest.embedding.version,
      vector_row_count: vectorRows.length,
      vector_row_key_sha256: vectorRows.map((row) => sha(row.vector_key)),
    },
  };
}

function privacySafeRecallTrace(result: any): Record<string, unknown> {
  return {
    status: result.status,
    coverage: result.coverage,
    diagnostics: result.diagnostics,
    results: result.results.map((item: any, index: number) => ({
      rank: index + 1,
      episode_ref_sha256: sha(item.episode_ref),
      revision_sha256: sha(item.revision),
      occurred_at: item.occurred_at,
      conversation_at: item.conversation_at,
      channels: item.channels,
      matched_node_ref_sha256: item.matched_node_ref
        ? sha(item.matched_node_ref)
        : null,
      association_path: item.association_path.map((edge: any) => ({
        from_sha256: sha(edge.from),
        relation: edge.relation,
        to_sha256: sha(edge.to),
        traversed_reverse: edge.traversed_reverse,
      })),
      evidence: item.evidence.map((evidence: any) => ({
        source_ref_sha256: sha(evidence.source_ref),
        basis: evidence.basis,
        source_resolved: evidence.source_resolved,
        conversation_session_id_sha256: sha(evidence.conversation_session_id),
        conversation_message_id_sha256: sha(evidence.conversation_message_id),
      })),
      qualifications: item.qualifications,
    })),
  };
}

function storedPathTrace(
  graphPath: string,
  path: any[],
): Array<Record<string, unknown>> {
  const db = new Database(graphPath, { readonly: true });
  try {
    return path.map((step) => {
      const edge = db
        .query<{ edge_id: string }, [string, string, string]>(
          `
        SELECT edge_id FROM edges WHERE source_node_id=? AND target_node_id=? AND rel_type=? ORDER BY edge_id LIMIT 1
      `,
        )
        .get(step.from, step.to, step.relation);
      if (!edge)
        throw new Error("returned graph path does not match stored endpoints");
      return {
        edge_id_sha256: sha(edge.edge_id),
        stored_from_sha256: sha(step.from),
        relation: step.relation,
        stored_to_sha256: sha(step.to),
        traversed_reverse: step.traversed_reverse,
      };
    });
  } finally {
    db.close();
  }
}

function lanceLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function requireS2EpisodeVector(
  butlerData: string,
  graphPath: string,
  expectedJobs: number,
  failedAtStart: Set<string>,
  poll: (input: { butlerData: string }) => Promise<{ action: string }>,
  budget: LivePollBudget,
): Promise<number> {
  for (let attempts = 1; attempts <= 64; attempts += 1) {
    const db = new Database(graphPath, { readonly: true });
    try {
      const complete = db
        .query<{ found: number }, [string]>(
          `
        SELECT 1 found FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id
        JOIN memory_chunk_sources s ON s.episode_id=j.episode_id AND s.revision=j.revision
        WHERE u.record_kind='episode' AND u.state='complete' AND s.content_hash=? LIMIT 1
      `,
        )
        .get(sha(S2));
      if (complete?.found === 1) {
        assertLiveWallBudget(budget);
        return attempts - 1;
      }
    } finally {
      db.close();
    }
    assertAllocatedProjectionState(graphPath, expectedJobs, undefined, budget.maxExtraLeaves);
    const result = await boundedLivePoll(poll, butlerData, budget);
    if (result.action !== "processed")
      throw new Error(`S2 vector projection did not process: ${result.action}`);
    assertNoNewVectorFailure(graphPath, failedAtStart);
  }
  throw new Error("S2 episode vector exceeded bounded quantum count");
}

function assertNoNewVectorFailure(
  graphPath: string,
  failedAtStart: Set<string>,
): void {
  const newFailure = failedVectorUnits(graphPath).find(
    (unit) => !failedAtStart.has(unit.unit_id),
  );
  if (newFailure)
    throw new Error(
      `vector projection stopped after failed receipt: ${newFailure.error_code}`,
    );
}

function failedVectorUnitIds(graphPath: string): Set<string> {
  return new Set(failedVectorUnits(graphPath).map((unit) => unit.unit_id));
}

function readSourceInstant(graphPath: string, contentHash: string): string {
  const db = new Database(graphPath, { readonly: true });
  try {
    const value = db
      .query<
        { observed_at: string },
        [string]
      >("SELECT observed_at FROM memory_chunk_sources WHERE content_hash=? ORDER BY observed_at DESC LIMIT 1")
      .get(contentHash)?.observed_at;
    if (!value || !Number.isFinite(Date.parse(value)))
      throw new Error("canonical source instant missing");
    return value;
  } finally {
    db.close();
  }
}

export function failedVectorUnits(
  graphPath: string,
): Array<{ unit_id: string; error_code: string }> {
  const db = new Database(graphPath, { readonly: true });
  try {
    const installed = db
      .query<
        { found: number },
        []
      >("SELECT 1 found FROM sqlite_master WHERE type='table' AND name='memory_vector_units'")
      .get();
    if (!installed) return [];
    const columns = new Set(
      db
        .query<{ name: string }, []>("PRAGMA table_info(memory_vector_units)")
        .all()
        .map((row) => row.name),
    );
    for (const required of ["unit_id", "state", "error_code"])
      if (!columns.has(required))
        throw new Error(
          `memory vector baseline schema mismatch: missing ${required}`,
        );
    const attemptedFailure = columns.has("attempt_count")
      ? " OR (attempt_count>0 AND error_code IS NOT NULL)"
      : "";
    return db
      .query<
        { unit_id: string; error_code: string },
        []
      >(`SELECT unit_id,error_code FROM memory_vector_units WHERE state='failed'${attemptedFailure} ORDER BY unit_id`)
      .all();
  } finally {
    db.close();
  }
}

type PreservedCompleteWindow = {
  windowRef: string;
  jobId: string;
  episodeId: string;
  revision: string;
  extractionVersion: string;
  generation: string;
  attemptCount: number;
  inputMigrationNote: "legacy_input_unavailable" | null;
  sourceRefsSha256: string;
  planSha256: string;
  outputSha256: string;
  providerEvidenceSha256: string;
  inputJsonSha256: string | null;
  storedInputSha256: string | null;
};
type PreservedCompleteBaseline = {
  expectedJobs: 3 | 4;
  expectedWindows: number;
  splitAllocation: boolean;
  newExtractorCallBudget: number;
  includeRecoveryHistory: boolean;
  failedB1?: {
    windowRef: string; jobId: string; inputJsonSha256: string; requestPath: string; attemptCount: number; splitExpected: boolean;
    canonicalRequestId: string; canonicalTurnId: string; canonicalSessionId: string;
  };
  completed: PreservedCompleteWindow[];
  pendingB1: {
    target: AppTarget;
    queue: Record<string, unknown>;
    nativeEventPath: string;
    nativeEventSha256: string;
  };
  historicalProviderInvocationRefs: string[];
  preservedAttempts: Array<Record<string, unknown>>;
};

type PreservedFailureBaseline = {
  expectedJobs: number;
  failedWindowRef: string;
  failedJobId: string;
  errorCode: string;
  sourceRefsSha256: string;
  outputSha256: string;
  providerEvidenceSha256: string;
  completed: Array<{
    windowRef: string;
    sourceRefsSha256: string;
    planSha256: string;
    outputSha256: string;
    providerEvidenceSha256: string;
  }>;
};

function readAndValidatePreservedCompleteBaseline(
  baselinePath: string,
  butlerData: string,
  generationId: string,
  graphPath: string,
  b1Request: string,
  failedB1 = false,
): PreservedCompleteBaseline {
  if (!baselinePath.trim())
    throw new Error("--preserved-complete-baseline is required");
  const manifest = JSON.parse(
    readFileSync(resolve(baselinePath), "utf8"),
  ) as any;
  const expectedJobs = failedB1 ? 4 : 3;
  const splitAllocation = failedB1 && manifest.split_allocation !== undefined;
  const expectedWindows = manifest.expected_windows;
  const includeRecoveryHistory = Array.isArray(manifest.preserved_attempts) &&
    manifest.preserved_attempts.some((row: any) => Object.hasOwn(row, "recovery_revision"));
  const history = manifest.historical_extractor_calls;
  const historicalCounts = [history?.total, history?.success, history?.failed,
    manifest.historical_checked_embedding_calls, manifest.historical_checked_embedding_vectors];
  if (
    manifest.schema !== (failedB1 ? "butler.memory.t2-t3.complete-three-failed-b1.v1" : "butler.memory.t2-t3.complete-three-pending-b1.v1") ||
    manifest.mode !== (failedB1 ? "preserved_complete_three_failed_b1" : "preserved_complete_three_pending_b1") ||
    resolve(manifest.root) !== butlerData ||
    manifest.generation_id !== generationId ||
    manifest.expected_jobs !== expectedJobs ||
    (!Number.isSafeInteger(expectedWindows) || expectedWindows < expectedJobs || expectedWindows > expectedJobs + (splitAllocation ? 4 : 0)) ||
    manifest.remaining_projection_obligations !== 7 ||
    manifest.new_POSTs_needed !== 6 ||
    manifest.B1_POSTs_needed !== 0 ||
    manifest.old_success_reextraction !== 0 ||
    historicalCounts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
    history.total !== history.success + history.failed ||
    !Array.isArray(manifest.original_source_subset) ||
    manifest.original_source_subset.length !== 2 ||
    !Array.isArray(manifest.preserved_complete_windows) ||
    manifest.preserved_complete_windows.length !== (failedB1 ? expectedWindows - 1 : expectedWindows) ||
    !Array.isArray(manifest.preserved_attempts) ||
    !Array.isArray(manifest.historical_provider_invocation_refs)
  )
    throw new Error("preserved complete checkpoint manifest mismatch");
  if (splitAllocation && (manifest.split_allocation?.max_extra_leaves !== 4 || manifest.split_allocation?.final_active_leaf_min !== 11 ||
    manifest.split_allocation?.final_active_leaf_max !== 14 || manifest.split_allocation?.final_total_window_max !== 18 ||
    manifest.split_allocation?.max_child_rows !== 8 ||
    !Number.isSafeInteger(manifest.split_allocation?.max_new_extractor_calls) ||
    manifest.split_allocation.max_new_extractor_calls < 1 || manifest.split_allocation.max_new_extractor_calls > 42 ||
    manifest.split_allocation?.max_wall_ms !== 10800000)) throw new Error("split continuation allocation manifest mismatch");
  const pending = failedB1 ? manifest.original_b1_admission : manifest.pending_b1;
  if (
    !pending ||
    pending.request_file !== "b-corpus-input-draft/b1.txt" ||
    pending.request_bytes !== Buffer.byteLength(b1Request) ||
    pending.request_sha256 !== sha(b1Request) ||
    pending.admitted_bytes !== Buffer.byteLength(b1Request.trim()) ||
    pending.admitted_sha256 !== sha(b1Request.trim()) ||
    pending.native_attempts !== 0 ||
    pending.canonical_exists !== false ||
    pending.btcc_inbox_exists !== false ||
    pending.message?.role !== "user" ||
    pending.message?.status !== "sent" ||
    pending.message?.conversation_session_id !== null ||
    pending.message?.conversation_turn_id !== null ||
    pending.message?.conversation_message_id !== null ||
    pending.turn?.state !== "thinking" ||
    pending.turn?.user_message_id !== pending.message?.id ||
    pending.turn?.id !== pending.message?.turn_id ||
    pending.queue?.state !== "dispatching" ||
    pending.queue?.dispatched_message_id !== pending.message?.id ||
    pending.queue?.turn_id !== pending.turn?.id
  )
    throw new Error("pending B1 checkpoint manifest mismatch");
  const completed: PreservedCompleteWindow[] =
    manifest.preserved_complete_windows.map((row: any) => {
      if (
        row.state !== "complete" ||
        row.generation !== generationId ||
        !Number.isSafeInteger(row.attempt_count) ||
        ![null, "legacy_input_unavailable"].includes(
          row.input_migration_note,
        ) ||
        typeof row.window_ref !== "string" ||
        typeof row.job_id !== "string" ||
        typeof row.episode_id !== "string" ||
        typeof row.revision !== "string" ||
        typeof row.extraction_version !== "string"
      )
        throw new Error("preserved complete window manifest mismatch");
      return {
        windowRef: row.window_ref,
        jobId: row.job_id,
        episodeId: row.episode_id,
        revision: row.revision,
        extractionVersion: row.extraction_version,
        generation: row.generation,
        attemptCount: row.attempt_count,
        inputMigrationNote: row.input_migration_note,
        sourceRefsSha256: row.source_refs_sha256,
        planSha256: row.normalized_plan_sha256,
        outputSha256: row.output_sha256,
        providerEvidenceSha256: row.provider_evidence_sha256,
        inputJsonSha256: row.input_json_sha256,
        storedInputSha256: row.stored_input_sha256,
      };
    });
  if (
    completed.filter(
      (row) =>
        row.inputMigrationNote === "legacy_input_unavailable" &&
        row.inputJsonSha256 &&
        row.storedInputSha256,
    ).length !== 1 ||
    completed.filter(
      (row) =>
        row.inputMigrationNote === null &&
        row.inputJsonSha256 === null &&
        row.storedInputSha256 === null,
    ).length !== 2
  )
    throw new Error("preserved input snapshot null semantics mismatch");

  const db = new Database(graphPath, { readonly: true });
  try {
    const counts = db
      .query<{ jobs: number; windows: number }, []>(
        `
      SELECT (SELECT COUNT(*) FROM memory_projection_jobs) jobs,
        (SELECT COUNT(*) FROM memory_projection_windows WHERE state!='replaced') windows
    `,
      )
      .get()!;
    if (Number(counts.jobs) !== expectedJobs || Number(counts.windows) !== expectedWindows)
      throw new Error("preserved complete allocation changed");
    for (const expected of completed) {
      const row = db
        .query<any, [string]>(
          `
        SELECT w.job_id,w.state,w.attempt_count,w.input_migration_note,w.source_refs_json,w.normalized_plan_json,
          w.output_json,w.provider_evidence_json,w.input_json,w.input_sha256,j.episode_id,j.revision,j.extraction_version,j.generation
        FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id WHERE w.window_ref=?
      `,
        )
        .get(expected.windowRef);
      if (
        !row ||
        row.job_id !== expected.jobId ||
        row.episode_id !== expected.episodeId ||
        row.revision !== expected.revision ||
        row.extraction_version !== expected.extractionVersion ||
        row.generation !== expected.generation ||
        row.state !== "complete" ||
        row.attempt_count !== expected.attemptCount ||
        row.input_migration_note !== expected.inputMigrationNote ||
        sha(row.source_refs_json) !== expected.sourceRefsSha256 ||
        sha(row.normalized_plan_json) !== expected.planSha256 ||
        sha(row.output_json) !== expected.outputSha256 ||
        sha(row.provider_evidence_json) !== expected.providerEvidenceSha256 ||
        (row.input_json === null ? null : sha(row.input_json)) !==
          expected.inputJsonSha256 ||
        row.input_sha256 !== expected.storedInputSha256
      )
        throw new Error("preserved complete window bytes changed");
    }
    const subsetHashes = new Set<string>();
    for (const expected of manifest.original_source_subset) {
      const row = db
        .query<any, [string, string, string]>(
          `
        SELECT s.source_id,s.episode_id,s.revision,w.job_id,w.source_refs_json,w.normalized_plan_json,w.output_json,w.provider_evidence_json,s.content_hash
        FROM memory_chunk_sources s JOIN memory_projection_jobs j ON j.episode_id=s.episode_id AND j.revision=s.revision
        JOIN memory_projection_windows w ON w.job_id=j.job_id JOIN json_each(w.source_refs_json) refs ON refs.value=s.source_id
        WHERE s.source_id=? AND w.window_ref=? AND j.job_id=?
      `,
        )
        .get(expected.source_id, expected.window_ref, expected.job_id);
      if (
        !row ||
        row.episode_id !== expected.episode_id ||
        row.revision !== expected.revision ||
        sha(row.source_refs_json) !== expected.source_refs_sha256 ||
        sha(row.normalized_plan_json) !== expected.normalized_plan_sha256 ||
        sha(row.output_json) !== expected.output_sha256 ||
        sha(row.provider_evidence_json) !== expected.provider_evidence_sha256
      )
        throw new Error("original S1/S2 source subset changed");
      subsetHashes.add(row.content_hash);
    }
    if (
      subsetHashes.size !== 2 ||
      !subsetHashes.has(sha(S1)) ||
      !subsetHashes.has(sha(S2))
    )
      throw new Error("original S1/S2 source subset identity mismatch");
    const attempts = db
      .query<any, []>(
        `
      SELECT attempt_ref,window_ref,job_id,attempt_count,attempt_kind,provider_invoked,outcome_known,invocation_ref,state,
        error_code,input_sha256,recorded_at,output_json,provider_evidence_json${includeRecoveryHistory ? ",recovery_revision,recovery_request_json" : ""} FROM memory_projection_attempts ORDER BY attempt_ref
    `,
      )
      .all();
    const expectedAttempts = manifest.preserved_attempts
      .map((row: any) => ({ ...row }))
      .sort((a: any, b: any) => a.attempt_ref.localeCompare(b.attempt_ref));
    const actualAttempts = attempts
      .filter((row: any) =>
        expectedAttempts.some(
          (item: any) => item.attempt_ref === row.attempt_ref,
        ),
      )
      .map((row: any) => ({
        attempt_ref: row.attempt_ref,
        window_ref: row.window_ref,
        job_id: row.job_id,
        attempt_count: row.attempt_count,
        attempt_kind: row.attempt_kind,
        provider_invoked: row.provider_invoked,
        outcome_known: row.outcome_known,
        invocation_ref: row.invocation_ref,
        state: row.state,
        error_code: row.error_code,
        input_sha256: row.input_sha256,
        recorded_at: row.recorded_at,
        output_sha256: row.output_json === null ? null : sha(row.output_json),
        provider_evidence_sha256:
          row.provider_evidence_json === null
            ? null
            : sha(row.provider_evidence_json),
        ...(includeRecoveryHistory ? { recovery_revision: row.recovery_revision, recovery_request_sha256: row.recovery_request_json === null ? null : sha(row.recovery_request_json) } : {}),
      }));
    if (JSON.stringify(actualAttempts) !== JSON.stringify(expectedAttempts))
      throw new Error("preserved attempt history changed");
    const invocationRefs = attempts
      .map((row: any) => row.invocation_ref)
      .filter(Boolean)
      .sort();
    if (
      JSON.stringify([...new Set(invocationRefs)]) !==
      JSON.stringify(
        [...new Set(manifest.historical_provider_invocation_refs)].sort(),
      )
    )
      throw new Error("historical provider invocation refs changed");
  } finally {
    db.close();
  }
  if (!failedB1) assertPendingB1Checkpoint(butlerData, {
    target: {
      chatId: pending.message.chat_id,
      messageId: pending.message.id,
      turnId: pending.turn.id,
      queueId: pending.queue.id,
      clientMessageId: pending.message.id,
      requestText: b1Request,
      admittedText: b1Request.trim(),
      requestBytes: pending.request_bytes,
      requestSha256: pending.request_sha256,
      admittedBytes: pending.admitted_bytes,
      admittedSha256: pending.admitted_sha256,
    },
    queue: pending.queue,
    nativeEventPath: pending.native_event_path,
    nativeEventSha256: pending.native_event_sha256,
  });
  return {
    expectedJobs, expectedWindows, splitAllocation, includeRecoveryHistory,
    newExtractorCallBudget: splitAllocation ? manifest.split_allocation.max_new_extractor_calls : 21,
    failedB1: failedB1 ? readFailedB1ReprocessCheckpoint(manifest.failed_b1, graphPath, generationId) : undefined,
    completed,
    pendingB1: {
      target: {
        chatId: pending.message.chat_id,
        messageId: pending.message.id,
        turnId: pending.turn.id,
        queueId: pending.queue.id,
        clientMessageId: pending.message.id,
        requestText: b1Request,
        admittedText: b1Request.trim(),
        requestBytes: pending.request_bytes,
        requestSha256: pending.request_sha256,
        admittedBytes: pending.admitted_bytes,
        admittedSha256: pending.admitted_sha256,
      },
      queue: pending.queue,
      nativeEventPath: pending.native_event_path,
      nativeEventSha256: pending.native_event_sha256,
    },
    historicalProviderInvocationRefs: [
      ...manifest.historical_provider_invocation_refs,
    ].sort(),
    preservedAttempts: manifest.preserved_attempts
      .map((row: any) => ({ ...row }))
      .sort((a: any, b: any) => a.attempt_ref.localeCompare(b.attempt_ref)),
  };
}

function readFailedB1ReprocessCheckpoint(
  expected: any,
  graphPath: string,
  generationId: string,
): NonNullable<PreservedCompleteBaseline["failedB1"]> {
  if (!expected || typeof expected.request_path !== "string" || typeof expected.request_sha256 !== "string")
    throw new Error("failed B1 reprocess request missing");
  const bytes = readFileSync(expected.request_path, "utf8");
  if (sha(bytes) !== expected.request_sha256) throw new Error("failed B1 reprocess request changed");
  const request = JSON.parse(bytes);
  const splitExpected = expected.split_after_local_exhaustion === true;
  const attemptCount = request.expected_attempt_count;
  const baseAttemptCount = expected.recovery_base_attempt_count ?? (splitExpected ? 1 : 0);
  if (request.schema !== "butler.memory.window-reprocess.v1" || request.expected_generation !== generationId ||
    !Number.isSafeInteger(attemptCount) || attemptCount < 1 ||
    !Number.isSafeInteger(baseAttemptCount) || baseAttemptCount < 0 || baseAttemptCount >= attemptCount)
    throw new Error("failed B1 reprocess request preimage mismatch");
  const db = new Database(graphPath, { readonly: true });
  try {
    const row = db.query<any, [string]>(`SELECT w.*,j.revision,j.generation,j.extraction_model,j.reasoning_effort
      FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id WHERE w.window_ref=?`).get(request.window_ref);
    const failure = db.query<any, [string]>("SELECT * FROM memory_projection_attempts WHERE attempt_ref=?").get(request.expected_failed_attempt_ref);
    if (!row || row.state !== "failed" || row.job_id !== request.job_id || row.attempt_count !== attemptCount || row.next_attempt_at !== null ||
      row.error_code !== request.expected_error_code || row.generation !== generationId || row.revision !== request.expected_source_revision ||
      row.extraction_model !== request.expected_model || row.reasoning_effort !== request.expected_reasoning_effort ||
      row.input_sha256 !== request.expected_input_sha256 || !row.input_json || sha(row.input_json) !== expected.input_json_sha256 ||
      row.output_json !== null || row.normalized_plan_json !== null || (expected.provider_evidence_sha256 ? sha(row.provider_evidence_json) !== expected.provider_evidence_sha256 : row.provider_evidence_json !== null) ||
      (row.recovery_revision ?? null) !== request.expected_recovery_revision || (row.recovery_base_attempt_count ?? 0) !== baseAttemptCount ||
      !failure || failure.state !== "failed" || failure.window_ref !== request.window_ref || failure.job_id !== request.job_id ||
      failure.attempt_count !== attemptCount || failure.error_code !== row.error_code || failure.input_sha256 !== row.input_sha256)
      throw new Error("preserved failed B1 window changed");
    if (request.expected_error_code === "memory_extract_timeout") {
      const failures = db.query<any, [string, string]>("SELECT * FROM memory_projection_attempts WHERE window_ref=? AND recovery_revision IS ? AND state='failed' ORDER BY attempt_count")
        .all(request.window_ref, request.expected_recovery_revision);
      if (failures.length !== 3 || new Set(failures.map((failure) => failure.invocation_ref)).size !== 3 || failures.some((failure, index) => {
        const evidence = JSON.parse(failure.provider_evidence_json ?? "null");
        return failure.attempt_count !== baseAttemptCount + index + 1 || failure.output_json !== null || failure.provider_invoked !== 1 || !failure.invocation_ref ||
          failure.input_sha256 !== row.input_sha256 || failure.error_code !== "memory_extract_timeout" || evidence?.failure_kind !== "before_result" ||
          evidence.timeout_origin !== "local" || evidence.code !== "memory_extract_timeout" || evidence.configured_model !== row.extraction_model;
      })) throw new Error("preserved B1 local deadline exhaustion evidence mismatch");
    }
    const source = db.query<any, [string, string]>(`SELECT s.conversation_session_id,s.conversation_message_id,c.conversation_turn_id
      FROM memory_chunk_sources s JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id
      WHERE s.source_id IN (SELECT value FROM json_each(?)) AND s.conversation_message_id=? AND s.role='user' AND s.origin_kind='user_input'`)
      .get(row.source_refs_json, expected.canonical_request_id);
    if (!source || source.conversation_session_id !== expected.canonical_session_id || source.conversation_turn_id !== expected.canonical_turn_id)
      throw new Error("preserved failed B1 source binding changed");
    return {
      attemptCount, splitExpected, windowRef: request.window_ref, jobId: request.job_id, inputJsonSha256: expected.input_json_sha256, requestPath: expected.request_path,
      canonicalRequestId: expected.canonical_request_id, canonicalTurnId: expected.canonical_turn_id, canonicalSessionId: expected.canonical_session_id,
    };
  } finally { db.close(); }
}

type CompletedCorpusCheckpoint = Pick<PreservedCompleteBaseline,
  "completed" | "preservedAttempts" | "includeRecoveryHistory" | "historicalProviderInvocationRefs"> & {
  expectedJobs: 7 | 10 | 12;
  expectedWindows: 8 | 11 | 13;
  targets: AppTarget[];
  failedS3?: {
    target: AppTarget;
    queryTarget: AppTarget;
    request: Record<string, any>;
    inputJsonSha256: string;
    canonicalRequestId: string;
    calls: Array<{ callId: string; argumentsSha256: string; resultSha256: string }>;
    priorExecution: Record<string, unknown>;
  };
};

function readCompletedCorpusCheckpoint(
  path: string, butlerData: string, generationId: string, graphPath: string, sources: string[], failedS3 = false,
): CompletedCorpusCheckpoint {
  const checkpoint = JSON.parse(readFileSync(path, "utf8"));
  if (checkpoint.schema !== (failedS3 ? "butler.memory.failed-s3-corpus.v1" : "butler.memory.completed-b-corpus.v1") || checkpoint.root !== butlerData ||
    checkpoint.generationId !== generationId || ![4, 7].includes(checkpoint.targets?.length) ||
    checkpoint.expectedJobs !== checkpoint.targets.length + (failedS3 ? 5 : 3) || checkpoint.expectedWindows !== checkpoint.expectedJobs + 1 ||
    checkpoint.completed?.length !== checkpoint.expectedWindows - (failedS3 ? 1 : 0) || !checkpoint.includeRecoveryHistory ||
    Boolean(checkpoint.failedS3) !== failedS3 || (failedS3 && checkpoint.targets.length !== 7) ||
    !Array.isArray(checkpoint.preservedAttempts) || !Array.isArray(checkpoint.historicalProviderInvocationRefs))
    throw new Error("completed B corpus checkpoint mismatch");
  for (const [index, target] of checkpoint.targets.entries()) {
    const original = sources[index]!;
    if (target.requestText !== original || target.admittedText !== original.trim() ||
      target.requestBytes !== Buffer.byteLength(original) || target.admittedBytes !== Buffer.byteLength(original.trim()) ||
      target.requestSha256 !== sha(original) || target.admittedSha256 !== sha(original.trim()))
      throw new Error("completed B source text changed");
  }
  if (failedS3) {
    const expected = checkpoint.failedS3;
    if (expected.target.admittedText !== S3 || expected.queryTarget.admittedText !== `${FIXED_B_CUE} canonical 근거를 읽어 주세요.`)
      throw new Error("preserved S3/comparison source text mismatch");
    const db = new Database(graphPath, { readonly: true });
    try {
      const rows = db.query<any, []>("SELECT * FROM memory_projection_windows WHERE state!='complete' AND state!='replaced'").all();
      const row = rows[0];
      if (rows.length !== 1 || row.state !== "failed" || row.window_ref !== expected.request.window_ref ||
        sha(row.input_json) !== expected.inputJsonSha256 || row.normalized_plan_json !== null)
        throw new Error("preserved failed S3 checkpoint changed");
      const bound = db.query<any, [string, string]>(`SELECT s.conversation_message_id,c.conversation_turn_id FROM memory_chunk_sources s
        JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id
        WHERE s.source_id IN (SELECT value FROM json_each(?)) AND s.content_hash=? AND s.role='user'`).get(row.source_refs_json, sha(S3));
      if (!bound || bound.conversation_message_id !== expected.canonicalRequestId || bound.conversation_turn_id !== expected.target.turnId)
        throw new Error("preserved failed S3 canonical binding changed");
    } finally { db.close(); }
  }
  assertPreservedCompleteHistory(graphPath, checkpoint);
  return checkpoint;
}

function readPreservedS3Comparison(butlerData: string, expected: NonNullable<CompletedCorpusCheckpoint["failedS3"]>) {
  const db = new Database(`${butlerData}/agent-runtime/btcc.sqlite`, { readonly: true });
  let calls: any[];
  try {
    calls = expected.calls.map((pin) => {
      const row = db.query<any, [string]>("SELECT * FROM btcc_guided_tool_calls WHERE call_id=?").get(pin.callId);
      if (!row || row.turn_id !== expected.queryTarget.turnId || sha(row.arguments_json) !== pin.argumentsSha256 || sha(row.result_json) !== pin.resultSha256)
        throw new Error("preserved native comparison call changed");
      return { name: row.tool_name, args: JSON.parse(row.arguments_json), result: JSON.parse(row.result_json) };
    });
  } finally { db.close(); }
  const [graph, hybrid, read] = calls;
  if (calls.length !== 3 || graph.name !== "recall_memory" || hybrid.name !== "recall_memory" || read.name !== "read_conversation_session" ||
    graph.args.include_vector !== false || hybrid.args.include_vector !== true || graph.args.as_of !== hybrid.args.as_of ||
    [graph, hybrid].some((call) => call.args.cue !== FIXED_B_CUE || call.args.scope !== "all_user_sessions" || call.args.project_filter !== "unassigned" ||
      call.args.include_internal !== false || call.args.limit !== 6 || call.result.ok !== true) || read.result.ok !== true)
    throw new Error("preserved native comparison contract mismatch");
  const graphPreference = graph.result.results.find((result: any) => result.evidence.some((item: any) => item.excerpt === S2));
  const hybridPreference = hybrid.result.results.find((result: any) => result.evidence.some((item: any) => item.excerpt === S2));
  if (!graphPreference || !hybridPreference?.channels.includes("vector")) throw new Error("preserved native S2 graph/vector contribution missing");
  const returnedReadArgs = hybridPreference.evidence.find((item: any) => item.excerpt === S2).read_args;
  if (Object.keys(returnedReadArgs).length !== Object.keys(read.args).length ||
    Object.entries(returnedReadArgs).some(([key, value]) => read.args[key] !== value)) throw new Error("preserved read_args changed");
  return {
    toolTrace: { graphRecall: graph.result, hybridRecall: hybrid.result, graphPreference, hybridPreference,
      returnedReadArgs, submittedReadArgs: Object.fromEntries(Object.keys(returnedReadArgs).map((key) => [key, read.args[key]])), read: read.result },
    comparison: { asOf: graph.args.as_of as string, trace: { status: "prior_execution_only", ephemeral_trace_available: false, ...expected.priorExecution } },
  };
}

function assertPreservedCompleteHistory(
  graphPath: string,
  expected: Pick<PreservedCompleteBaseline, "completed" | "preservedAttempts" | "includeRecoveryHistory">,
): void {
  const db = new Database(graphPath, { readonly: true });
  try {
    for (const item of expected.completed) {
      const row = db
        .query<any, [string]>(
          `
        SELECT w.job_id,w.state,w.attempt_count,w.input_migration_note,w.source_refs_json,w.normalized_plan_json,
          w.output_json,w.provider_evidence_json,w.input_json,w.input_sha256,j.episode_id,j.revision,j.extraction_version,j.generation
        FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id WHERE w.window_ref=?
      `,
        )
        .get(item.windowRef);
      if (
        !row ||
        row.job_id !== item.jobId ||
        row.episode_id !== item.episodeId ||
        row.revision !== item.revision ||
        row.extraction_version !== item.extractionVersion ||
        row.generation !== item.generation ||
        row.state !== "complete" ||
        row.attempt_count !== item.attemptCount ||
        row.input_migration_note !== item.inputMigrationNote ||
        sha(row.source_refs_json) !== item.sourceRefsSha256 ||
        sha(row.normalized_plan_json) !== item.planSha256 ||
        sha(row.output_json) !== item.outputSha256 ||
        sha(row.provider_evidence_json) !== item.providerEvidenceSha256 ||
        (row.input_json === null ? null : sha(row.input_json)) !==
          item.inputJsonSha256 ||
        row.input_sha256 !== item.storedInputSha256
      )
        throw new Error(
          "preserved complete history changed during continuation",
        );
    }
    const attempts = db
      .query<any, []>(
        `
      SELECT attempt_ref,window_ref,job_id,attempt_count,attempt_kind,provider_invoked,outcome_known,invocation_ref,state,
        error_code,input_sha256,recorded_at,output_json,provider_evidence_json${expected.includeRecoveryHistory ? ",recovery_revision,recovery_request_json" : ""} FROM memory_projection_attempts ORDER BY attempt_ref
    `,
      )
      .all();
    const actual = attempts
      .filter((row: any) =>
        expected.preservedAttempts.some(
          (item: any) => item.attempt_ref === row.attempt_ref,
        ),
      )
      .map((row: any) => ({
        attempt_ref: row.attempt_ref,
        window_ref: row.window_ref,
        job_id: row.job_id,
        attempt_count: row.attempt_count,
        attempt_kind: row.attempt_kind,
        provider_invoked: row.provider_invoked,
        outcome_known: row.outcome_known,
        invocation_ref: row.invocation_ref,
        state: row.state,
        error_code: row.error_code,
        input_sha256: row.input_sha256,
        recorded_at: row.recorded_at,
        output_sha256: row.output_json === null ? null : sha(row.output_json),
        provider_evidence_sha256:
          row.provider_evidence_json === null
            ? null
            : sha(row.provider_evidence_json),
        ...(expected.includeRecoveryHistory ? { recovery_revision: row.recovery_revision, recovery_request_sha256: row.recovery_request_json === null ? null : sha(row.recovery_request_json) } : {}),
      }));
    if (JSON.stringify(actual) !== JSON.stringify(expected.preservedAttempts))
      throw new Error(
        "preserved failed attempt history changed during continuation",
      );
  } finally {
    db.close();
  }
}

function assertPendingB1Checkpoint(
  butlerData: string,
  pending: PreservedCompleteBaseline["pendingB1"],
): void {
  const appDb = new Database(`${butlerData}/app.sqlite`, { readonly: true });
  try {
    const message = appDb
      .query<
        any,
        [string]
      >(`SELECT id,chat_id,turn_id,role,status,created_at,conversation_session_id,conversation_turn_id,conversation_message_id FROM messages WHERE id=?`)
      .get(pending.target.messageId!);
    const turn = appDb
      .query<
        any,
        [string]
      >(`SELECT id,chat_id,user_message_id,state,attempt,created_at,updated_at FROM turns WHERE id=?`)
      .get(pending.target.turnId!);
    const queue = appDb
      .query<
        any,
        [string]
      >(`SELECT id,state,dispatched_message_id,turn_id,claim_id,claim_owner,claimed_at,lease_expires_at,created_at,updated_at FROM session_queued_messages WHERE id=?`)
      .get(pending.target.queueId!);
    if (
      !message ||
      !turn ||
      !queue ||
      message.id !== pending.target.messageId ||
      turn.id !== pending.target.turnId ||
      JSON.stringify(queue) !== JSON.stringify(pending.queue) ||
      message.conversation_session_id !== null ||
      message.conversation_turn_id !== null ||
      message.conversation_message_id !== null ||
      turn.state !== "thinking"
    )
      throw new Error("pending B1 App target changed before resume");
  } finally {
    appDb.close();
  }
  const eventPath = resolve(butlerData, pending.nativeEventPath);
  if (
    !eventPath.startsWith(`${butlerData}/`) ||
    !existsSync(eventPath) ||
    sha(readFileSync(eventPath, "utf8")) !== pending.nativeEventSha256
  )
    throw new Error("pending B1 native event changed before resume");
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  if (event.attempts !== 0)
    throw new Error("pending B1 native attempt count changed before resume");
  const canonicalPath = `${butlerData}/runtime/conversation-store.sqlite`;
  if (existsSync(canonicalPath)) {
    const canonical = new Database(canonicalPath, { readonly: true });
    try {
      const found = Number(
        canonical
          .query<
            { n: number },
            [string, string]
          >(`SELECT COUNT(*) n FROM conversation_messages WHERE id=? OR source_ref=?`)
          .get(pending.target.messageId!, pending.target.messageId!)!.n,
      );
      if (found !== 0)
        throw new Error("pending B1 already has canonical source");
    } finally {
      canonical.close();
    }
  }
}

function readAndValidatePreservedFailureBaseline(
  baselinePath: string,
  butlerData: string,
  generationId: string,
  graphPath: string,
): PreservedFailureBaseline {
  if (!baselinePath.trim())
    throw new Error("--preserved-failure-baseline is required");
  const manifest = JSON.parse(
    readFileSync(resolve(baselinePath), "utf8"),
  ) as any;
  if (
    manifest.schema !== "butler.memory.t2-t3.failed-baseline.v1" ||
    manifest.mode !== "preserved_failed_third" ||
    resolve(manifest.root) !== butlerData ||
    manifest.generation_id !== generationId ||
    manifest.expected_jobs !== 3 ||
    manifest.expected_state !== "failed" ||
    manifest.normalized_plan_is_null !== true ||
    manifest.original_input_snapshot_available !== false ||
    manifest.queue_observation_already_acked !== true ||
    !Array.isArray(manifest.preserved_complete_windows) ||
    manifest.preserved_complete_windows.length !== 2
  )
    throw new Error("preserved failure baseline manifest mismatch");
  const expected: PreservedFailureBaseline = {
    expectedJobs: manifest.expected_jobs,
    failedWindowRef: manifest.failed_window_ref,
    failedJobId: manifest.failed_job_id,
    errorCode: manifest.expected_error_code,
    sourceRefsSha256: manifest.source_refs_sha256,
    outputSha256: manifest.output_sha256,
    providerEvidenceSha256: manifest.provider_evidence_sha256,
    completed: manifest.preserved_complete_windows.map((row: any) => ({
      windowRef: row.window_ref,
      sourceRefsSha256: row.source_refs_sha256,
      planSha256: row.plan_sha256,
      outputSha256: row.output_sha256,
      providerEvidenceSha256: row.provider_evidence_sha256,
    })),
  };
  const db = new Database(graphPath, { readonly: true });
  try {
    const jobs = Number(
      db
        .query<
          { n: number },
          []
        >("SELECT COUNT(*) n FROM memory_projection_jobs")
        .get()!.n,
    );
    const failed = db
      .query<
        {
          job_id: string;
          state: string;
          error_code: string;
          source_refs_json: string;
          output_json: string;
          provider_evidence_json: string;
          normalized_plan_json: string | null;
        },
        [string]
      >(
        `
      SELECT job_id,state,error_code,source_refs_json,output_json,provider_evidence_json,normalized_plan_json
      FROM memory_projection_windows WHERE window_ref=?
    `,
      )
      .get(expected.failedWindowRef);
    if (
      jobs !== expected.expectedJobs ||
      !failed ||
      failed.job_id !== expected.failedJobId ||
      failed.state !== "failed" ||
      failed.error_code !== expected.errorCode ||
      failed.normalized_plan_json !== null ||
      sha(failed.source_refs_json) !== expected.sourceRefsSha256 ||
      sha(failed.output_json) !== expected.outputSha256 ||
      sha(failed.provider_evidence_json) !== expected.providerEvidenceSha256
    )
      throw new Error("preserved failed window baseline changed");
    for (const item of expected.completed) {
      const row = db
        .query<
          {
            source_refs_json: string;
            normalized_plan_json: string;
            output_json: string;
            provider_evidence_json: string;
            state: string;
          },
          [string]
        >(
          `
        SELECT source_refs_json,normalized_plan_json,output_json,provider_evidence_json,state FROM memory_projection_windows WHERE window_ref=?
      `,
        )
        .get(item.windowRef);
      if (
        !row ||
        row.state !== "complete" ||
        sha(row.source_refs_json) !== item.sourceRefsSha256 ||
        sha(row.normalized_plan_json) !== item.planSha256 ||
        sha(row.output_json) !== item.outputSha256 ||
        sha(row.provider_evidence_json) !== item.providerEvidenceSha256
      )
        throw new Error("preserved successful plan baseline changed");
    }
  } finally {
    db.close();
  }
  return expected;
}

async function recoverPreservedFailedWindow(input: {
  butlerData: string;
  graphPath: string;
  failedAtStart: Set<string>;
  expected: PreservedFailureBaseline;
  budget: LivePollBudget;
  poll: (input: { butlerData: string }) => Promise<{ action: string }>;
}): Promise<number> {
  const startedCalls = input.budget.calls;
  let ownerObservedLegacy = false;
  while (
    input.budget.calls < input.budget.maxCalls &&
    Date.now() < input.budget.deadlineAt
  ) {
    assertAllocatedProjectionState(
      input.graphPath,
      input.expected.expectedJobs,
      input.expected.failedWindowRef,
    );
    const state = readRecoveryWindowState(
      input.graphPath,
      input.expected.failedWindowRef,
    );
    if (state.state === "complete") return input.budget.calls - startedCalls;
    if (
      ownerObservedLegacy &&
      (state.state === "unsupported" ||
        (state.state === "failed" && !state.nextAttemptAt))
    )
      throw new Error(
        `preserved failure recovery stopped: ${state.errorCode ?? state.state}`,
      );
    if (state.nextAttemptAt && Date.parse(state.nextAttemptAt) > Date.now()) {
      await Bun.sleep(
        Math.min(
          250,
          Date.parse(state.nextAttemptAt) - Date.now(),
          Math.max(0, input.budget.deadlineAt - Date.now()),
        ),
      );
      continue;
    }
    const result = await boundedLivePoll(
      input.poll,
      input.butlerData,
      input.budget,
    );
    ownerObservedLegacy = true;
    if (!["processed", "idle"].includes(result.action))
      throw new Error(`preserved failure recovery stopped: ${result.action}`);
    assertNoNewVectorFailure(input.graphPath, input.failedAtStart);
  }
  throw new Error("preserved failure recovery exceeded bounded allocation");
}

function createLivePollBudget(
  maxCalls: number,
  maxWallClockMs: number,
  splitContinuation = false,
): LivePollBudget {
  if (
    !Number.isSafeInteger(maxCalls) ||
    maxCalls < 1 ||
    maxCalls > 512 ||
    !Number.isSafeInteger(maxWallClockMs) ||
    maxWallClockMs < 1 ||
    maxWallClockMs > (splitContinuation ? 180 : 30) * 60_000
  )
    throw new Error("preserved failure recovery bounds are required");
  return { calls: 0, maxCalls, deadlineAt: Date.now() + maxWallClockMs, maxExtraLeaves: splitContinuation ? 4 : 0 };
}

function createIngressPollBudget(
  maxCalls: number,
  deadlineAt: number,
): IngressPollBudget {
  if (
    !Number.isSafeInteger(maxCalls) ||
    maxCalls < 1 ||
    maxCalls > 512 ||
    !Number.isFinite(deadlineAt)
  )
    throw new Error("preserved continuation ingress poll bound is required");
  return { calls: 0, maxCalls, deadlineAt };
}

function assertLiveWallBudget(budget: LivePollBudget): void {
  if (Date.now() >= budget.deadlineAt)
    throw new Error("memory live harness exceeded bounded allocation");
}

async function boundedLivePoll(
  poll: (input: { butlerData: string }) => Promise<{ action: string }>,
  butlerData: string,
  budget: LivePollBudget,
): Promise<{ action: string }> {
  if (budget.calls >= budget.maxCalls)
    throw new Error("memory live harness exceeded bounded poll allocation");
  assertLiveWallBudget(budget);
  budget.calls += 1;
  const result = await poll({ butlerData });
  assertLiveWallBudget(budget);
  return result;
}

export function assertAllocatedProjectionState(
  graphPath: string,
  expectedJobs: number,
  allowedFailedWindowRef?: string,
  maxExtraLeaves = 0,
): {
  jobs: number;
  windows: number;
  window_jobs: number;
  split_children: number;
  complete: number;
  failed: number;
  pending: number;
  next_attempt_at: string | null;
} {
  const db = new Database(graphPath, { readonly: true });
  try {
    const columns = new Set(
      db
        .query<{ name: string }, []>(
          "PRAGMA table_info(memory_projection_windows)",
        )
        .all()
        .map((row) => row.name),
    );
    for (const required of ["window_ref", "job_id", "state"])
      if (!columns.has(required))
        throw new Error(
          `memory projection baseline schema mismatch: missing ${required}`,
        );
    const splitChildren = columns.has("parent_window_ref")
      ? "SUM(parent_window_ref IS NOT NULL)"
      : "0";
    const nextAttemptAt = columns.has("next_attempt_at")
      ? "MIN(CASE WHEN state IN ('pending','planned') THEN next_attempt_at END)"
      : "NULL";
    const state = db
      .query<
        {
          jobs: number;
          windows: number;
          window_jobs: number;
          split_children: number;
          complete: number;
          failed: number;
          pending: number;
          next_attempt_at: string | null;
        },
        []
      >(
        `SELECT (SELECT COUNT(*) FROM memory_projection_jobs) jobs,COUNT(*) windows,COUNT(DISTINCT job_id) window_jobs,
      ${splitChildren} split_children,SUM(state='complete') complete,SUM(state IN ('failed','unsupported')) failed,
      SUM(state IN ('pending','planned','running')) pending,${nextAttemptAt} next_attempt_at
      FROM memory_projection_windows WHERE state!='replaced'`,
      )
      .get()!;
    const allowedFailures = allowedFailedWindowRef
      ? Number(
          db
            .query<
              { n: number },
              [string]
            >("SELECT COUNT(*) n FROM memory_projection_windows WHERE window_ref=? AND state='failed'")
            .get(allowedFailedWindowRef)?.n ?? 0,
        )
      : 0;
    const allowedExtra = Math.min(maxExtraLeaves, Math.max(0, expectedJobs - 3));
    if (
      Number(state.jobs) > expectedJobs ||
      Number(state.windows) > expectedJobs + allowedExtra ||
      Number(state.split_children) > 2 * allowedExtra ||
      Number(state.failed) !== allowedFailures
    )
      throw new Error(
        `memory projection exceeded allocated source windows: ${JSON.stringify(state)}`,
      );
    if (
      Number(state.jobs) === expectedJobs &&
      (Number(state.windows) < expectedJobs ||
        Number(state.window_jobs) !== expectedJobs)
    )
      throw new Error(
        `memory projection source/window identity mismatch: ${JSON.stringify(state)}`,
      );
    return state;
  } finally {
    db.close();
  }
}

function readRecoveryWindowState(
  graphPath: string,
  windowRef: string,
): { state: string; errorCode: string | null; nextAttemptAt: string | null } {
  const db = new Database(graphPath, { readonly: true });
  try {
    const columns = new Set(
      db
        .query<{ name: string }, []>(
          "PRAGMA table_info(memory_projection_windows)",
        )
        .all()
        .map((row) => row.name),
    );
    const row = db
      .query<
        {
          state: string;
          error_code: string | null;
          next_attempt_at?: string | null;
        },
        [string]
      >(
        columns.has("next_attempt_at")
          ? "SELECT state,error_code,next_attempt_at FROM memory_projection_windows WHERE window_ref=?"
          : "SELECT state,error_code,NULL next_attempt_at FROM memory_projection_windows WHERE window_ref=?",
      )
      .get(windowRef);
    if (!row) throw new Error("preserved failed window missing");
    return {
      state: row.state,
      errorCode: row.error_code,
      nextAttemptAt: row.next_attempt_at ?? null,
    };
  } finally {
    db.close();
  }
}

function assertPreservedFailureRecovery(
  graphPath: string,
  expected: PreservedFailureBaseline,
): void {
  const db = new Database(graphPath, { readonly: true });
  try {
    const migrated = db
      .query<
        { input_migration_note: string | null; state: string },
        [string]
      >("SELECT input_migration_note,state FROM memory_projection_windows WHERE window_ref=?")
      .get(expected.failedWindowRef);
    const failedAttempt = db
      .query<
        {
          output_json: string;
          provider_evidence_json: string;
          error_code: string;
        },
        [string]
      >(
        `
      SELECT output_json,provider_evidence_json,error_code FROM memory_projection_attempts
      WHERE window_ref=? AND attempt_count=1 AND state='failed'
    `,
      )
      .get(expected.failedWindowRef);
    if (
      !migrated ||
      migrated.state !== "complete" ||
      migrated.input_migration_note !== "legacy_input_unavailable" ||
      !failedAttempt ||
      failedAttempt.error_code !== expected.errorCode ||
      sha(failedAttempt.output_json) !== expected.outputSha256 ||
      sha(failedAttempt.provider_evidence_json) !==
        expected.providerEvidenceSha256
    )
      throw new Error(
        "legacy failure evidence was not preserved through recovery",
      );
    for (const item of expected.completed) {
      const row = db
        .query<
          {
            source_refs_json: string;
            normalized_plan_json: string;
            output_json: string;
            provider_evidence_json: string;
            state: string;
          },
          [string]
        >(
          `
        SELECT source_refs_json,normalized_plan_json,output_json,provider_evidence_json,state FROM memory_projection_windows WHERE window_ref=?
      `,
        )
        .get(item.windowRef);
      if (
        !row ||
        row.state !== "complete" ||
        sha(row.source_refs_json) !== item.sourceRefsSha256 ||
        sha(row.normalized_plan_json) !== item.planSha256 ||
        sha(row.output_json) !== item.outputSha256 ||
        sha(row.provider_evidence_json) !== item.providerEvidenceSha256
      )
        throw new Error("successful plan changed during legacy recovery");
    }
  } finally {
    db.close();
  }
}

function preservesCompletedPlans(
  actual: ReturnType<typeof readAcceptedCorpusState>["completedPlans"],
  expected: ReturnType<typeof readAcceptedCorpusState>["completedPlans"],
): boolean {
  const byWindow = new Map(actual.map((row) => [row.window_ref, row]));
  return expected.every((row) => JSON.stringify(byWindow.get(row.window_ref)) === JSON.stringify(row));
}

function readAcceptedCorpusState(graphPath: string): {
  jobs: number;
  windows: number;
  preservedSources: number;
  completedPlans: Array<{
    window_ref: string;
    plan_sha: string;
    evidence_sha: string;
    output_sha: string;
  }>;
} {
  const db = new Database(graphPath, { readonly: true });
  try {
    const jobs = Number(
      db
        .query<
          { n: number },
          []
        >("SELECT COUNT(*) n FROM memory_projection_jobs")
        .get()!.n,
    );
    const windows = Number(
      db
        .query<
          { n: number },
          []
        >("SELECT COUNT(*) n FROM memory_projection_windows WHERE state!='replaced'")
        .get()!.n,
    );
    const preservedSources = Number(
      db
        .query<
          { n: number },
          [string, string]
        >("SELECT COUNT(DISTINCT content_hash) n FROM memory_chunk_sources WHERE content_hash IN (?,?)")
        .get(sha(S1), sha(S2))!.n,
    );
    const completedPlans = db
      .query<
        {
          window_ref: string;
          normalized_plan_json: string;
          provider_evidence_json: string;
          output_json: string;
        },
        []
      >(
        `
      SELECT window_ref,normalized_plan_json,provider_evidence_json,output_json FROM memory_projection_windows
      WHERE state='complete' AND normalized_plan_json IS NOT NULL AND provider_evidence_json IS NOT NULL AND output_json IS NOT NULL
      ORDER BY rowid
    `,
      )
      .all()
      .map((row) => ({
        window_ref: row.window_ref,
        plan_sha: sha(row.normalized_plan_json),
        evidence_sha: sha(row.provider_evidence_json),
        output_sha: sha(row.output_json),
      }));
    return { jobs, windows, preservedSources, completedPlans };
  } finally {
    db.close();
  }
}

function final(text: string): ModelRoundResult {
  return { text, toolCalls: [] };
}

function tool(
  id: string,
  name: string,
  args: Record<string, unknown>,
): ModelRoundResult {
  return {
    text: "",
    toolCalls: [
      { id, name, arguments: args, rawArguments: JSON.stringify(args) },
    ],
  };
}

function tools(
  calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
): ModelRoundResult {
  return {
    text: "",
    toolCalls: calls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.args,
      rawArguments: JSON.stringify(call.args),
    })),
  };
}

function toolCallById(request: ModelRoundRequest, id: string) {
  const call = request.messages
    .flatMap((message) => message.toolCalls ?? [])
    .find((item) => item.id === id);
  if (!call) throw new Error(`missing tool call: ${id}`);
  return call;
}

function toolOutputById(request: ModelRoundRequest, id: string): any {
  const message = request.messages.find(
    (item) => item.role === "tool" && item.toolCallId === id,
  );
  if (!message) throw new Error(`missing tool result: ${id}`);
  const result = JSON.parse(message.content);
  return result.output ?? result;
}

function lastToolOutput(request: ModelRoundRequest, name: string): any {
  const message = request.messages
    .filter((item) => item.role === "tool" && item.name === name)
    .at(-1);
  if (!message) throw new Error(`missing tool result: ${name}`);
  const result = JSON.parse(message.content);
  return result.output ?? result;
}

function markExecutorReady(root: string): void {
  mkdirSync(`${root}/state`, { recursive: true });
  writeFileSync(
    `${root}/state/butler-main-native.json`,
    JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      runtime: "memory-recovery-live-harness",
      launcher: "memory-recovery-multilingual-live-e2e",
    }),
  );
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

if (import.meta.main) {
  const index = process.argv.indexOf("--data-root");
  const dataRoot = index >= 0 ? (process.argv[index + 1] ?? "") : "";
  const qualificationIndex = process.argv.indexOf("--finalize-t4-qualification");
  if (qualificationIndex >= 0) {
    const optionValue = (name: string) => { const marker = process.argv.indexOf(name); return marker >= 0 ? process.argv[marker + 1] ?? "" : ""; };
    process.stdout.write(`${JSON.stringify(await finalizeT4Qualification({
      tracePath: optionValue("--t4-trace"), semanticReviewPath: optionValue("--t4-semantic-review"),
      performanceRawPath: optionValue("--t4-performance-raw"),
      ownerEvidenceDir: optionValue("--t4-owner-evidence-dir"), supportEvidenceDir: optionValue("--t4-support-evidence-dir"),
      outputDir: optionValue("--t4-qualification-output-dir"),
      implementationCommit: optionValue("--implementation-commit"),
    }))}\n`);
    process.exit(0);
  }
  const fullCliChild = process.argv.includes("--t4-full-cli-child");
  if (fullCliChild) {
    const acceptanceMarker = process.argv.indexOf("--acceptance");
    const buildsMarker = process.argv.indexOf("--max-builds");
    process.stdout.write(`${JSON.stringify(await runT4FullCliLifecycleChild({ root: resolve(dataRoot),
      acceptancePath: process.argv[acceptanceMarker + 1] ?? "", maxBuilds: Number(process.argv[buildsMarker + 1] ?? 0) }))}\n`);
    process.exit(0);
  }
  if (process.argv.includes("--run-t4-full-cli")) {
    const acceptanceMarker = process.argv.indexOf("--acceptance");
    const buildsMarker = process.argv.indexOf("--max-builds");
    process.stdout.write(`${JSON.stringify(runT4FullCliLifecycle({ root: resolve(dataRoot),
      acceptancePath: process.argv[acceptanceMarker + 1] ?? "", maxBuilds: Number(process.argv[buildsMarker + 1] ?? 0) }))}\n`);
    process.exit(0);
  }
  const checkpointIndex = process.argv.indexOf("--prepare-t4-final-checkpoint");
  if (checkpointIndex >= 0) {
    process.stdout.write(`${JSON.stringify(prepareT4FinalCheckpoint(dataRoot, process.argv[checkpointIndex + 1] ?? ""))}\n`);
    process.exit(0);
  }
  const corpusIndex = process.argv.indexOf("--b-corpus-dir");
  const bCorpusDir =
    corpusIndex >= 0 ? (process.argv[corpusIndex + 1] ?? "") : "";
  const dispatcherOnly = process.argv.includes("--dispatcher-only");
  const failedBaselineIndex = process.argv.indexOf(
    "--preserved-failure-baseline",
  );
  const completeBaselineIndex = process.argv.indexOf(
    "--preserved-complete-baseline",
  );
  const t4BaselineIndex = process.argv.indexOf("--t4-actual-baseline");
  const t4ResumeAfterQ1Index = process.argv.indexOf("--t4-resume-after-q1");
  const maxPollIndex = process.argv.indexOf("--max-recovery-polls");
  const maxIngressIndex = process.argv.indexOf("--max-ingress-polls");
  const maxWallIndex = process.argv.indexOf("--max-recovery-wall-ms");
  const performanceBindingIndex = process.argv.indexOf("--t4-performance-query-binding");
  const performanceArtifactIndex = process.argv.indexOf("--t4-performance-artifact-dir");
  const supplementRoundsIndex = process.argv.indexOf("--max-supplement-logical-rounds");
  const supplementDispatchesIndex = process.argv.indexOf("--max-supplement-dispatches");
  const projectionPollsIndex = process.argv.indexOf("--max-performance-projection-polls");
  const performanceWallIndex = process.argv.indexOf("--max-performance-wall-ms");
  const performance = performanceBindingIndex >= 0 ? {
    queryBindingPath: process.argv[performanceBindingIndex + 1] ?? "",
    artifactDir: resolve(performanceArtifactIndex >= 0 ? process.argv[performanceArtifactIndex + 1] ?? "" : ""),
    supplementMaxLogicalRounds: Number(supplementRoundsIndex >= 0 ? process.argv[supplementRoundsIndex + 1] ?? 0 : 0),
    supplementMaxDispatches: Number(supplementDispatchesIndex >= 0 ? process.argv[supplementDispatchesIndex + 1] ?? 0 : 0),
    projectionMaxPollCalls: Number(projectionPollsIndex >= 0 ? process.argv[projectionPollsIndex + 1] ?? 0 : 0),
    performanceMaxWallClockMs: Number(performanceWallIndex >= 0 ? process.argv[performanceWallIndex + 1] ?? 0 : 0),
  } satisfies T4PerformanceOptions : undefined;
  const recovery: LiveRecoveryMode =
    t4BaselineIndex >= 0
      ? {
          kind: "t4_actual_phase",
          baselinePath: process.argv[t4BaselineIndex + 1] ?? "",
          maxPollCalls: Number(process.argv[maxPollIndex + 1] ?? 0),
          maxIngressPollCalls: Number(process.argv[maxIngressIndex + 1] ?? 0),
          maxWallClockMs: Number(process.argv[maxWallIndex + 1] ?? 0),
          performance,
          resumeAfterQ1ReviewPath: t4ResumeAfterQ1Index >= 0
            ? process.argv[t4ResumeAfterQ1Index + 1] ?? "" : undefined,
        }
      : completeBaselineIndex >= 0
      ? {
          kind: process.argv.includes("--reprocess-failed-b1") ? "preserved_complete_three_failed_b1" : "preserved_complete_three_pending_b1",
          baselinePath: process.argv[completeBaselineIndex + 1] ?? "",
          maxPollCalls: Number(process.argv[maxPollIndex + 1] ?? 0),
          maxIngressPollCalls: Number(process.argv[maxIngressIndex + 1] ?? 0),
          maxWallClockMs: Number(process.argv[maxWallIndex + 1] ?? 0),
        }
      : failedBaselineIndex >= 0
        ? {
            kind: "preserved_failed_third",
            baselinePath: process.argv[failedBaselineIndex + 1] ?? "",
            maxPollCalls: Number(process.argv[maxPollIndex + 1] ?? 0),
            maxWallClockMs: Number(process.argv[maxWallIndex + 1] ?? 0),
          }
        : { kind: "accepted_pending" };
  process.stdout.write(
    `${JSON.stringify(
      dispatcherOnly
        ? await runMemoryRecoveryDispatcherHarness(dataRoot)
        : await runMemoryRecoveryLiveHarness(dataRoot, bCorpusDir, recovery),
    )}\n`,
  );
}
