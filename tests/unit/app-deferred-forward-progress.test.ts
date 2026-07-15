import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppServer } from "../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts";
import { NativeInboundQueue } from "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";
import { GatewayRouter } from "../../packages/butler-agent/src/gateways/core/router.ts";
import { createGatewayServer } from "../../packages/butler-agent/src/gateways/core/server.ts";
import {
  createLifecycleGatewayHandlers,
  SessionLifecycleService,
} from "../../packages/butler-agent/src/interfaces/gateway/session-lifecycle.ts";
import { processQueuedInboundEvents } from "../../packages/butler-agent/src/interfaces/gateway/queued-inbound.ts";
import { createAppTransportAdapter } from "../../packages/butler-agent/src/interfaces/transport/app/adapter.ts";
import { DeliveryGuard } from "../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts";
import { TurnSchedulerContinuationYieldError } from "../../packages/butler-agent/src/agent/turn/turn-continuation-context.ts";
import { readTurnContextAtom } from "../../packages/butler-agent/src/agent/turn/turn-continuation-context.ts";
import { NativeToolLoopRuntime } from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import { createEvidenceCapabilityReceipt } from "../../packages/butler-agent/src/agent/output/evidence/parser.ts";
import { serializeToolResultPayloadForProvider } from "../../packages/butler-agent/src/agent/context/completed-tool-evidence.ts";
import type {
  AgentRuntimeAdapter,
  ModelProviderAdapter,
  RuntimeSessionHandle,
  RuntimeSessionInit,
  RuntimeTurnInput,
} from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { BtccRecoveryCaseStore } from "../../packages/butler-agent/src/agent/turn/interruption/recovery-case-store.ts";
import { btccFixtureResponse } from "../support/btcc-phase-fixture.ts";

let tempDir = "";
let originalButlerData: string | undefined;
let originalButlerHome: string | undefined;
let conversationWriter: AgentConversationStore;
let btccStateWriter: BtccRecoveryCaseStore;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-app-deferred-progress-"));
  originalButlerData = process.env.BUTLER_DATA;
  originalButlerHome = process.env.BUTLER_HOME;
  process.env.BUTLER_DATA = tempDir;
  process.env.BUTLER_HOME = process.cwd();
  conversationWriter = new AgentConversationStore({ butlerData: tempDir });
  btccStateWriter = new BtccRecoveryCaseStore({ butlerData: tempDir });
});

afterEach(() => {
  btccStateWriter.close();
  conversationWriter.close();
  if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalButlerData;
  if (originalButlerHome === undefined) delete process.env.BUTLER_HOME;
  else process.env.BUTLER_HOME = originalButlerHome;
  rmSync(tempDir, { recursive: true, force: true });
});

function managedQueueContract() {
  return {
    conversationWriter,
    btccInterruptionStateWriter: btccStateWriter,
  };
}

class BudgetFailureThenSuccessRuntime implements AgentRuntimeAdapter {
  readonly id = "native-tool-loop";
  readonly prompts: string[] = [];
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
      runtimeSessionRef: `deferred:${input.sessionId}`,
    };
  }

  async runTurn(input: RuntimeTurnInput) {
    this.prompts.push(
      "message" in input.input
        ? input.input.message.text ?? ""
        : input.input.text,
    );
    if (this.prompts.length === 1) {
      const error = new Error(
        "Prompt usage model-call budget exhausted before provider request",
      );
      error.name = "PromptUsageModelCallBudgetExhaustedError";
      Object.assign(error, {
        code: "prompt_usage_model_call_budget_exhausted",
      });
      throw error;
    }
    return {
      text: "두 번째 메시지는 독립된 새 턴에서 처리했습니다.",
      runtimeSessionRef: input.handle.runtimeSessionRef,
    };
  }
}

class OwnedContinuationThenSuccessRuntime implements AgentRuntimeAdapter {
  readonly id = "native-tool-loop";
  calls = 0;
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
      runtimeSessionRef: `owned-continuation:${input.sessionId}`,
    };
  }

  async runTurn(input: RuntimeTurnInput) {
    this.calls += 1;
    const turnId = "input" in input && "message" in input.input
      ? input.input.routingHints?.turnId ?? "turn-owned-continuation"
      : "turn-owned-continuation";
    if (this.calls === 1) {
      throw new TurnSchedulerContinuationYieldError(
        input.handle.sessionId,
        turnId,
        "turn-kernel/owned-continuation.json",
        "turn-kernel/owned-continuation.json:g1",
        1,
      );
    }
    return {
      text: "예약된 동일 턴 continuation이 작업을 완료했습니다.",
      runtimeSessionRef: input.handle.runtimeSessionRef,
    };
  }
}

const provider: ModelProviderAdapter = {
  id: "openai",
  capabilities: {
    supportsStreaming: false,
    supportsToolCalls: true,
    supportsImages: false,
    supportsAudio: false,
    supportsServerThreads: false,
    supportsReasoningConfig: true,
    supportsPromptCaching: true,
    supportsStructuredOutputs: true,
    structuredDecisionTransport: "json_schema",
  },
  async invoke() {
    return { text: "unused" };
  },
};

test("real App route rolls a Sandy-shaped spent budget into one owned continuation", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  const toolPrompts: string[] = [];
  let typedDecisionCalls = 0;
  let toolPromptCalls = 0;
  let firstTurnCompleted = false;
  let finalizationCalls = 0;
  const plan = [{
    id: "inspect",
    content: "현재 음성 경로를 확인합니다.",
    active_form: "현재 음성 경로를 확인하고 있습니다.",
    status: "in_progress" as const,
    phase: "execution" as const,
  }, {
    id: "implement",
    content: "음성 경로를 수정합니다.",
    active_form: "음성 경로를 수정하고 있습니다.",
    status: "pending" as const,
    phase: "execution" as const,
    blocked_by: ["inspect"],
  }, {
    id: "validate",
    content: "수정 결과를 검증합니다.",
    active_form: "수정 결과를 검증하고 있습니다.",
    status: "pending" as const,
    phase: "review" as const,
    blocked_by: ["implement"],
  }, {
    id: "report",
    content: "완료 결과를 보고합니다.",
    active_form: "완료 결과를 보고하고 있습니다.",
    status: "pending" as const,
    phase: "reporting" as const,
    blocked_by: ["validate"],
  }];
  const runtime = new NativeToolLoopRuntime({
    butlerData: tempDir,
    butlerHome: process.cwd(),
    appMessageDbPath: dbPath,
    disableAutomaticRecall: true,
    runPromptText: async (input) => {
      if (input.usageAttribution?.phase === "budget_exhaustion_finalization") {
        finalizationCalls += 1;
        throw new Error("budget-only finalization must not run");
      }
      if (input.responseFormat?.name?.startsWith("butler_btcc_")) {
        return btccFixtureResponse({
          prompt: input.prompt,
          responseFormat: input.responseFormat,
          options: {
            action: "inspect",
            reportText: input.prompt.includes("두 번째 질문은 이전 작업과 분리해 답했습니다.")
              ? "두 번째 질문은 이전 작업과 분리해 답했습니다."
              : "샌디 음성 경로 구현과 검증을 같은 작업에서 완료했습니다.",
            requiredEffects: ["observe", "mutate", "validation"],
          },
        });
      }
      typedDecisionCalls += 1;
      return JSON.stringify(firstTurnCompleted
        ? {
          schema_version: "butler.turn-contract-decision.v1",
          decision_id: decisionIdFromFormat(input.responseFormat),
          action: "answer",
          target_workstream_id: null,
          target_project_id: null,
          blocker_id: null,
          evidence_domain: null,
          inspection_scope: null,
          deliverables: [],
          answer_text: "두 번째 질문은 이전 작업과 분리해 답했습니다.",
          public_title: "독립 질문 답변",
          public_summary: "새 질문에만 답합니다.",
          public_rationale: "이전 continuation은 이미 완료되었습니다.",
          immediate_next_step: null,
        }
        : {
          schema_version: "butler.turn-contract-decision.v1",
          decision_id: decisionIdFromFormat(input.responseFormat),
          action: "start_work",
          target_workstream_id: null,
          target_project_id: null,
          blocker_id: null,
          evidence_domain: null,
          inspection_scope: null,
          deliverables: ["code_change", "validation", "final_report"],
          answer_text: null,
          public_title: "샌디 음성 경로 구현",
          public_summary: "큰 도구 근거를 확인한 뒤 음성 경로를 수정하고 검증합니다.",
          public_rationale: "실제 샌디 세션과 같은 누적 프롬프트 압력을 재현합니다.",
          immediate_next_step: "계획을 고정하고 관련 파일을 확인합니다.",
        });
    },
    runFunctionToolPromptText: async (input) => {
      toolPromptCalls += 1;
      toolPrompts.push(input.prompt);
      const admit = (roundIndex: number, promptTokens: number) => {
        input.usageAttribution?.beforeModelRequest?.({ roundIndex });
        input.usageAttribution?.beforeAdmittedModelRequest?.({
          roundIndex,
          phase: input.usageAttribution.phase,
          admittedPromptTokens: promptTokens,
          requestedOutputTokens: input.usageAttribution.requestedOutputTokens ?? 0,
          requestHash: `sandy-budget-${toolPromptCalls}-${roundIndex}`,
        });
        input.usageAttribution?.afterModelResponseUsage?.({
          model: "openai/gpt-5.5",
          promptTokens,
          cachedTokens: Math.floor(promptTokens / 2),
          outputTokens: 100,
          totalTokens: promptTokens + 100,
          roundIndex,
        });
      };
      if (toolPromptCalls === 1) {
        for (let roundIndex = 0; roundIndex < 6; roundIndex += 1) {
          admit(roundIndex, 29_000);
          const call = roundIndex === 0
            ? { name: "update_todo_list", args: { title: "샌디 음성 경로", todos: plan } }
            : { name: "read_file", args: { path: `src/voice/evidence-${roundIndex}.ts` } };
          await input.onAssistantTextBeforeTools?.({
            text: [
              `title: 샌디 근거 ${roundIndex + 1}`,
              "summary: 현재 음성 구현 근거를 순서대로 확인합니다.",
              "rationale: 확인된 상태를 유지한 채 다음 구현 단계로 진행해야 합니다.",
              "next_step: 남은 근거를 확인하거나 실제 변경을 수행합니다.",
            ].join("\n"),
            toolCalls: [call],
          });
          const output = await input.executeTool({ ...call, rawArguments: JSON.stringify(call.args) });
          serializeToolResultPayloadForProvider({
            payload: { ok: true, output },
            toolName: call.name,
            toolCallId: `sandy-call-${roundIndex}`,
            evidenceRetention: {
              butlerData: tempDir,
              turnId: input.usageAttribution?.turnId,
            },
          });
        }
        const budgetError = new Error(
          "Prompt usage model-call budget exhausted before provider request",
        );
        budgetError.name = "PromptUsageModelCallBudgetExhaustedError";
        Object.assign(budgetError, {
          code: "prompt_usage_model_call_budget_exhausted",
        });
        throw budgetError;
      }

      admit(0, 1_000);
      expect(input.prompt).toContain("## Resumed Typed Turn Contract");
      const calls = [{
        name: "write_file",
        args: { path: "src/voice/rollover-proof.ts", content: "export const voiceReady = true;\n", overwrite: false },
      }, {
        name: "run_command",
        args: { command: "bun test voice-rollover", validation_suite: "voice-rollover" },
      }, {
        name: "update_todo_list",
        args: {
          title: "샌디 음성 경로",
          todos: plan.map((todo) => todo.id === "report"
            ? todo
            : { ...todo, status: "completed" as const }),
        },
      }];
      await input.onAssistantTextBeforeTools?.({
        text: [
          "title: 샌디 음성 경로 완료",
          "summary: 체크포인트 근거를 이어받아 구현과 검증을 완료합니다.",
          "rationale: 같은 계약의 미완료 의무를 닫아야 합니다.",
          "next_step: 검증된 결과를 사용자에게 보고합니다.",
        ].join("\n"),
        toolCalls: calls,
      });
      for (const [index, call] of calls.entries()) {
        const output = await input.executeTool({ ...call, rawArguments: JSON.stringify(call.args) });
        serializeToolResultPayloadForProvider({
          payload: { ok: true, output },
          toolName: call.name,
          toolCallId: `sandy-resume-${index}`,
          evidenceRetention: {
            butlerData: tempDir,
            turnId: input.usageAttribution?.turnId,
          },
        });
      }
      firstTurnCompleted = true;
      return "샌디 음성 경로 구현과 검증을 같은 작업에서 완료했습니다.";
    },
    executeButlerTool: async (call) => {
      if (call.name === "read_file") {
        return {
          ok: true,
          content: `${"voice-evidence-line\n".repeat(20_000)}SANDY_RAW_TAIL_MARKER`,
          state_revision: `read-${String(call.args.path)}`,
        };
      }
      return {
        ok: true,
        state_revision: `${call.name}-complete`,
        evidence_capability_receipts: call.name === "write_file"
          ? [createEvidenceCapabilityReceipt({
            producer: { kind: "tool", name: "write_file" },
            capability: "workspace_mutated",
            evidence_kind: "mutation_result",
            summary: "The Sandy voice path was changed.",
          })]
          : call.name === "run_command"
          ? [createEvidenceCapabilityReceipt({
            producer: { kind: "tool", name: "run_command" },
            capability: "validation_passed",
            evidence_kind: "execution_result",
            summary: "The Sandy voice rollover validation passed.",
          })]
          : [],
      };
    },
  });
  const appServer = createAppServer({
    dbPath,
    butlerData: tempDir,
    butlerHome: process.cwd(),
    port: 0,
    automationSchedulerIntervalMs: false,
  });
  const queue = new NativeInboundQueue(tempDir);
  let bindingStore: SessionBindingStore | undefined;

  try {
    const posted = await postJson(`${appServer.url}messages`, {
      chat_id: "general",
      text: "샌디에게 목소리를 달아주는 작업을 계속 진행해줘.",
      queue_policy: "send_now",
    });
    const turnId = posted.data.turn.id as string;
    bindingStore = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
    const lifecycle = new SessionLifecycleService({
      ...managedQueueContract(),
      store: bindingStore,
      runtime,
      provider,
      systemPromptFactory: () => "You are Sandy. Complete the bound work contract.",
      sessionTitleGenerator: false,
      openingDecisionTimeoutMs: 0,
    });
    const gateway = createGatewayServer({
      router: new GatewayRouter({ store: bindingStore }),
      handlers: createLifecycleGatewayHandlers(lifecycle),
      butlerData: tempDir,
    });
    const deliveryGuard = new DeliveryGuard({ adapters: [createAppTransportAdapter()] });

    const yielded = await processQueuedInboundEvents({
      ...managedQueueContract(),
      queue,
      server: gateway,
      store: bindingStore,
      deliveryGuard,
    });
    expect(yielded).toMatchObject({ claimed: 1, handled: 1, failed: 0, delivered: 0 });
    expect(btccStateWriter.readTurnState(turnId)).toMatchObject({ state: "continuing" });
    expect(existingQueueFiles(tempDir, "pending")).toHaveLength(1);
    const atom = readTurnContextAtom({
      butlerData: tempDir,
      sessionId: "butler/app-general",
      turnId,
    });
    expect(atom).toMatchObject({
      generation: 1,
      budgetSnapshot: {
        executionSlice: 2,
        modelRequestsUsed: 0,
        promptTokens: 0,
        cumulativeUsage: {
          modelRequestsUsed: 5,
          promptTokens: 145_000,
        },
      },
    });
    const continuing = await getJson(`${appServer.url}session-view?session_id=general`);
    expect(continuing.data.active_turn).toMatchObject({ id: turnId, state: "thinking" });

    const completed = await processQueuedInboundEvents({
      ...managedQueueContract(),
      queue,
      server: gateway,
      store: bindingStore,
      deliveryGuard,
    });
    expect(completed).toMatchObject({ claimed: 1, handled: 1, failed: 0 });
    expect(existingQueueFiles(tempDir, "pending")).toEqual([]);
    expect(readTurnContextAtom({
      butlerData: tempDir,
      sessionId: "butler/app-general",
      turnId,
    })).toBeNull();
    expect(toolPrompts).toHaveLength(2);
    expect(toolPrompts[1]).toContain("Scheduler Continuation Context Atom");
    expect(toolPrompts[1]).not.toContain("SANDY_RAW_TAIL_MARKER");
    expect(toolPrompts[1]!.length).toBeLessThan(100_000);
    expect(evidenceArtifactCount(tempDir)).toBeGreaterThan(0);
    expect(finalizationCalls).toBe(0);

    const firstMessages = await getJson(`${appServer.url}messages?chat_id=general&cursor=0`);
    expect(firstMessages.data.messages.filter((message: { role: string }) => message.role === "user"))
      .toHaveLength(1);
    expect(firstMessages.data.messages).toContainEqual(expect.objectContaining({
      role: "assistant",
      turn_id: turnId,
      text: "샌디 음성 경로 구현과 검증을 같은 작업에서 완료했습니다.",
      status: "delivered",
    }));

    const unrelated = await postJson(`${appServer.url}messages`, {
      chat_id: "general",
      text: "이전 작업과 완전히 별개인 질문이야.",
      queue_policy: "send_now",
    });
    expect(unrelated.data.turn.id).not.toBe(turnId);
    const unrelatedCompleted = await processQueuedInboundEvents({
      ...managedQueueContract(),
      queue,
      server: gateway,
      store: bindingStore,
      deliveryGuard,
    });
    expect(unrelatedCompleted).toMatchObject({ claimed: 1, handled: 1, failed: 0 });
    const allMessages = await getJson(`${appServer.url}messages?chat_id=general&cursor=0`);
    expect(allMessages.data.messages).toContainEqual(expect.objectContaining({
      role: "assistant",
      turn_id: unrelated.data.turn.id,
      text: "두 번째 질문은 이전 작업과 분리해 답했습니다.",
      status: "delivered",
    }));
    expect(typedDecisionCalls).toBe(2);
    expect(toolPromptCalls).toBe(2);
  } finally {
    bindingStore?.close();
    appServer.stop();
  }
});

test("real deferred App route parks a budget interruption until Stop isolates the next message", async () => {
  const runtime = new BudgetFailureThenSuccessRuntime();
  const appServer = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    butlerHome: process.cwd(),
    port: 0,
    automationSchedulerIntervalMs: false,
  });
  const queue = new NativeInboundQueue(tempDir);
  let bindingStore: SessionBindingStore | undefined;

  try {
    const first = await postJson(`${appServer.url}messages`, {
      chat_id: "general",
      text: "첫 번째 장기 작업을 계속해줘.",
      queue_policy: "send_now",
    });
    const firstTurnId = first.data.turn.id as string;
    expect(first.data.turn).toMatchObject({
      state: "thinking",
      cancellable: true,
    });

    bindingStore = new SessionBindingStore(
      join(tempDir, "runtime", "session-store.sqlite"),
    );
    const lifecycle = new SessionLifecycleService({
      ...managedQueueContract(),
      store: bindingStore,
      runtime,
      provider,
      systemPromptFactory: () => "Deferred App forward-progress integration test.",
      sessionTitleGenerator: false,
      openingDecisionTimeoutMs: 0,
    });
    const gateway = createGatewayServer({
      router: new GatewayRouter({ store: bindingStore }),
      handlers: createLifecycleGatewayHandlers(lifecycle),
      butlerData: tempDir,
    });
    const deliveryGuard = new DeliveryGuard({
      adapters: [createAppTransportAdapter()],
    });

    const waitingSummary = await processQueuedInboundEvents({
      ...managedQueueContract(),
      queue,
      server: gateway,
      store: bindingStore,
      deliveryGuard,
    });
    expect(waitingSummary).toMatchObject({
      claimed: 1,
      handled: 1,
      delivered: 0,
      failed: 0,
    });

    const failedQueueDir = join(
      tempDir,
      "runtime",
      "inbound-events",
      "failed",
    );
    const failedFiles = existsSync(failedQueueDir)
      ? readdirSync(failedQueueDir).filter((name) => name.endsWith(".json"))
      : [];
    expect(failedFiles).toHaveLength(0);
    const btccState = btccStateWriter.readTurnState(firstTurnId);
    const recoveryCase = btccState?.activeRecoveryCaseId
      ? btccStateWriter.readRecoveryCase(btccState.activeRecoveryCaseId)
      : null;
    expect(btccState).toMatchObject({ state: "waiting_runtime" });
    expect(recoveryCase).toMatchObject({
      owner: "turn_runtime_recovery",
      status: "open",
      diagnosticRefs: expect.arrayContaining([
        "runtime-failure:prompt_usage_model_call_budget_exhausted",
      ]),
    });
    expect(existingQueueFiles(tempDir, "pending")).toEqual([]);

    const recoveryTurns = await getJson(
      `${appServer.url}turns?chat_id=general&cursor=0`,
    );
    expect(recoveryTurns.data.turns).toContainEqual(expect.objectContaining({
      id: firstTurnId,
      state: "thinking",
      retryable: false,
      cancellable: true,
    }));
    expect(JSON.stringify(recoveryTurns)).not.toContain("turn.failed");
    const recoveryView = await getJson(
      `${appServer.url}session-view?session_id=general`,
    );
    expect(recoveryView.data.active_turn).toMatchObject({
      id: firstTurnId,
      state: "thinking",
    });
    expect(bindingStore.getBySessionId("butler/app-general")?.lifecycleState)
      .toBe("active");

    const stopped = await postJson(
      `${appServer.url}turns/${encodeURIComponent(firstTurnId)}/cancel`,
      {},
    );
    expect(stopped.data.turn).toMatchObject({
      id: firstTurnId,
      state: "cancelled",
      cancellable: false,
    });

    const second = await postJson(`${appServer.url}messages`, {
      chat_id: "general",
      text: "이것은 별개의 두 번째 질문이야.",
      queue_policy: "enqueue_if_busy",
    });
    expect(second.data.queued).toBeUndefined();
    expect(second.data.turn).toMatchObject({ state: "thinking", attempt: 1 });
    expect(second.data.turn.id).not.toBe(firstTurnId);

    const deliveredSummary = await processQueuedInboundEvents({
      ...managedQueueContract(),
      queue,
      server: gateway,
      store: bindingStore,
      deliveryGuard,
    });
    expect(deliveredSummary).toMatchObject({
      claimed: 1,
      handled: 1,
      failed: 0,
    });

    const messages = await getJson(
      `${appServer.url}messages?chat_id=general&cursor=0`,
    );
    expect(messages.data.messages).toContainEqual(expect.objectContaining({
      role: "assistant",
      turn_id: second.data.turn.id,
      text: "두 번째 메시지는 독립된 새 턴에서 처리했습니다.",
      status: "delivered",
    }));
    const finalView = await getJson(
      `${appServer.url}session-view?session_id=general`,
    );
    expect(finalView.data.active_turn).toBeNull();
    expect(runtime.prompts).toEqual([
      "첫 번째 장기 작업을 계속해줘.",
      "이것은 별개의 두 번째 질문이야.",
    ]);
  } finally {
    bindingStore?.close();
    appServer.stop();
  }
});

test("real deferred App route keeps a turn nonterminal only while a scheduler owner exists", async () => {
  const runtime = new OwnedContinuationThenSuccessRuntime();
  const appServer = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    butlerHome: process.cwd(),
    port: 0,
    automationSchedulerIntervalMs: false,
  });
  const queue = new NativeInboundQueue(tempDir);
  let bindingStore: SessionBindingStore | undefined;

  try {
    const posted = await postJson(`${appServer.url}messages`, {
      chat_id: "general",
      text: "예산 경계 뒤에도 같은 작업을 이어서 완료해줘.",
      queue_policy: "send_now",
    });
    const turnId = posted.data.turn.id as string;
    bindingStore = new SessionBindingStore(
      join(tempDir, "runtime", "session-store.sqlite"),
    );
    const lifecycle = new SessionLifecycleService({
      ...managedQueueContract(),
      store: bindingStore,
      runtime,
      provider,
      systemPromptFactory: () => "Owned continuation integration test.",
      sessionTitleGenerator: false,
      openingDecisionTimeoutMs: 0,
    });
    const gateway = createGatewayServer({
      router: new GatewayRouter({ store: bindingStore }),
      handlers: createLifecycleGatewayHandlers(lifecycle),
      butlerData: tempDir,
    });
    const deliveryGuard = new DeliveryGuard({
      adapters: [createAppTransportAdapter()],
    });

    const yielded = await processQueuedInboundEvents({
      ...managedQueueContract(),
      queue,
      server: gateway,
      store: bindingStore,
      deliveryGuard,
    });
    expect(yielded).toMatchObject({
      claimed: 1,
      handled: 1,
      delivered: 0,
      failed: 0,
    });
    expect(existingQueueFiles(tempDir, "pending")).toHaveLength(1);
    expect(existingQueueFiles(tempDir, "failed")).toEqual([]);
    const firstProcessedPath = join(
      tempDir,
      "runtime",
      "inbound-events",
      "processed",
      existingQueueFiles(tempDir, "processed")[0]!,
    );
    const firstReceipt = JSON.parse(readFileSync(firstProcessedPath, "utf8"));
    expect(firstReceipt.metadata).toMatchObject({
      dispatchStatus: "continuing",
      handled: true,
      continuationScheduled: true,
      checkpointId: "turn-kernel/owned-continuation.json:g1",
    });
    expect(firstReceipt.metadata.schedulerItemId).toBeString();

    const continuingView = await getJson(
      `${appServer.url}session-view?session_id=general`,
    );
    expect(continuingView.data.active_turn).toMatchObject({
      id: turnId,
      state: "thinking",
    });

    const completed = await processQueuedInboundEvents({
      ...managedQueueContract(),
      queue,
      server: gateway,
      store: bindingStore,
      deliveryGuard,
    });
    expect(completed).toMatchObject({
      claimed: 1,
      handled: 1,
      failed: 0,
    });
    expect(existingQueueFiles(tempDir, "pending")).toEqual([]);
    expect(existingQueueFiles(tempDir, "processed")).toHaveLength(2);

    const messages = await getJson(
      `${appServer.url}messages?chat_id=general&cursor=0`,
    );
    expect(messages.data.messages.filter(
      (message: { role: string }) => message.role === "user",
    )).toHaveLength(1);
    expect(messages.data.messages.filter(
      (message: { role: string }) => message.role === "assistant",
    )).toEqual([
      expect.objectContaining({
        turn_id: turnId,
        text: "예약된 동일 턴 continuation이 작업을 완료했습니다.",
        status: "delivered",
      }),
    ]);
    const completedView = await getJson(
      `${appServer.url}session-view?session_id=general`,
    );
    expect(completedView.data.active_turn).toBeNull();
    expect(runtime.calls).toBe(2);
  } finally {
    bindingStore?.close();
    appServer.stop();
  }
});

function existingQueueFiles(
  butlerData: string,
  bucket: "pending" | "processing" | "processed" | "failed",
): string[] {
  const path = join(butlerData, "runtime", "inbound-events", bucket);
  return existsSync(path)
    ? readdirSync(path).filter((name) => name.endsWith(".json"))
    : [];
}

function evidenceArtifactCount(root: string): number {
  const artifactRoot = join(root, "artifacts", "tool-evidence");
  if (!existsSync(artifactRoot)) return 0;
  return readdirSync(artifactRoot, { recursive: true })
    .filter((entry) => String(entry).endsWith(".json"))
    .length;
}

function decisionIdFromFormat(format: { schema: Record<string, unknown> } | undefined): string {
  const value = format?.schema && typeof format.schema === "object"
    ? (format.schema as { properties?: { decision_id?: { const?: unknown } } })
      .properties?.decision_id?.const
    : null;
  if (typeof value !== "string") throw new Error("decision id missing from response format");
  return value;
}

async function getJson(url: string) {
  const response = await fetch(url);
  const parsed = await response.json();
  expect(response.ok, JSON.stringify(parsed)).toBe(true);
  return parsed;
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = await response.json();
  expect(response.ok, JSON.stringify(parsed)).toBe(true);
  return parsed;
}
