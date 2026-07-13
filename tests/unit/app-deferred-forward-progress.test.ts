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
import type {
  AgentRuntimeAdapter,
  ModelProviderAdapter,
  RuntimeSessionHandle,
  RuntimeSessionInit,
  RuntimeTurnInput,
} from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";

let tempDir = "";
let originalButlerData: string | undefined;
let originalButlerHome: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-app-deferred-progress-"));
  originalButlerData = process.env.BUTLER_DATA;
  originalButlerHome = process.env.BUTLER_HOME;
  process.env.BUTLER_DATA = tempDir;
  process.env.BUTLER_HOME = process.cwd();
});

afterEach(() => {
  if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalButlerData;
  if (originalButlerHome === undefined) delete process.env.BUTLER_HOME;
  else process.env.BUTLER_HOME = originalButlerHome;
  rmSync(tempDir, { recursive: true, force: true });
});

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
  },
  async invoke() {
    return { text: "unused" };
  },
};

test("real deferred App route terminates an ownerless budget failure and isolates the next message", async () => {
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

    const failedSummary = await processQueuedInboundEvents({
      queue,
      server: gateway,
      store: bindingStore,
      deliveryGuard,
    });
    expect(failedSummary).toMatchObject({
      claimed: 1,
      handled: 0,
      delivered: 1,
      failed: 1,
    });

    const failedQueueDir = join(
      tempDir,
      "runtime",
      "inbound-events",
      "failed",
    );
    const failedFiles = readdirSync(failedQueueDir).filter((name) =>
      name.endsWith(".json"),
    );
    expect(failedFiles).toHaveLength(1);
    const failedReceipt = JSON.parse(
      readFileSync(join(failedQueueDir, failedFiles[0]!), "utf8"),
    );
    expect(failedReceipt.metadata.failure).toMatchObject({
      code: "prompt_usage_model_call_budget_exhausted",
      retryable: true,
    });
    expect(JSON.stringify(failedReceipt)).not.toContain("continuationOnly");
    expect(existingQueueFiles(tempDir, "pending")).toEqual([]);

    const failedTurns = await getJson(
      `${appServer.url}turns?chat_id=general&cursor=0`,
    );
    expect(failedTurns.data.turns).toContainEqual(expect.objectContaining({
      id: firstTurnId,
      state: "failed",
      safe_error_code: "prompt_usage_model_call_budget_exhausted",
      cancellable: false,
    }));
    const failedView = await getJson(
      `${appServer.url}session-view?session_id=general`,
    );
    expect(failedView.data.active_turn).toBeNull();
    expect(bindingStore.getBySessionId("butler/app-general")?.lifecycleState)
      .toBe("active");

    const second = await postJson(`${appServer.url}messages`, {
      chat_id: "general",
      text: "이것은 별개의 두 번째 질문이야.",
      queue_policy: "enqueue_if_busy",
    });
    expect(second.data.queued).toBeUndefined();
    expect(second.data.turn).toMatchObject({ state: "thinking", attempt: 1 });
    expect(second.data.turn.id).not.toBe(firstTurnId);

    const deliveredSummary = await processQueuedInboundEvents({
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
