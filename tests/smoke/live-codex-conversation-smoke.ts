import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createGatewayServer } from "../../packages/butler-agent/src/gateways/core/server.ts";
import { createLifecycleGatewayHandlers, SessionLifecycleService } from "../../packages/butler-agent/src/interfaces/gateway/session-lifecycle.ts";
import { GatewayRouter } from "../../packages/butler-agent/src/gateways/core/router.ts";
import type { ModelProviderAdapter } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { NativeToolLoopRuntime } from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import { DeliveryGuard } from "../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts";
import { MockTransportAdapter } from "../../packages/butler-agent/src/interfaces/transport/mock/adapter.ts";

const butlerHome = process.env.BUTLER_HOME || process.cwd();
const previousButlerData = process.env.BUTLER_DATA;
const tempDir = mkdtempSync(join(tmpdir(), "butler-live-codex-smoke-"));

const provider: ModelProviderAdapter = {
  id: "codex-api-live-smoke",
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

const expectedLanguage = process.env.BUTLER_SMOKE_LANGUAGE || "ko";
const expectedStartTexts = expectedLanguage === "ko"
  ? ["이 작업은 워커로 처리하겠습니다", "작업에 착수했습니다", "백그라운드 워커로", "백그라운드 워커 작업을 시작했습니다"]
  : ["I will handle this with a worker", "I have started the work"];
const expectedCompleteTexts = expectedLanguage === "ko"
  ? ["워커 디스패치 완료했습니다", "디스패치 완료했습니다", "작업이 시작되었습니다", "작업을 시작했습니다", "작업에 착수했습니다"]
  : ["Worker dispatch completed", "Dispatch completed", "Work has started"];

try {
  process.env.BUTLER_HOME = butlerHome;
  process.env.BUTLER_DATA = tempDir;

  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const runtime = new NativeToolLoopRuntime({
    butlerHome,
    butlerData: tempDir,
    messageLanguage: expectedLanguage === "ko" ? "ko" : "en",
    executeButlerTool: async (call) => {
      if (call.name !== "dispatch_worker") {
        throw new Error(`unexpected tool ${call.name}`);
      }
      const taskId = "live-codex-smoke-task";
      const taskDir = join(tempDir, "tasks", taskId);
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "status"), "RUNNING\n", "utf8");
      writeFileSync(join(taskDir, "request.md"), String(call.args.task || ""), "utf8");
      return {
        ok: true,
        task_id: taskId,
        status: "RUNNING",
      };
    },
  });

  store.upsert({
    sessionId: "butler/main",
    role: "butler",
    projectId: "butler",
    workspacePath: butlerHome,
    runtimeAdapterId: runtime.id,
    modelProviderId: provider.id,
    modelRef: "openai/gpt-5.5-codex",
    transportBindings: [{
      transport: "mock",
      accountId: "default",
      peerId: "peer-live",
    }],
  });

  const mock = new MockTransportAdapter({ id: "mock" });
  const guard = new DeliveryGuard({ adapters: [mock] });
  const router = new GatewayRouter({ store });
  const lifecycle = new SessionLifecycleService({
    store,
    runtime,
    provider,
    systemPromptFactory: () => [
      "You are Butler.",
      "If the user explicitly asks to run a worker or dispatch background work, you must call dispatch_worker before final response.",
      "Do not merely say you will do it; call the tool.",
    ].join("\n"),
    deliverIntermediate: async ({ binding, action, metadata }) => {
      await guard.deliver(binding.sessionId, action, metadata);
    },
  });
  const server = createGatewayServer({
    router,
    handlers: createLifecycleGatewayHandlers(lifecycle),
  });

  await mock.start(async (event) => {
    const result = await server.handleInbound(event);
    if (result.status !== "handled") {
      throw new Error(`not handled: ${result.status}`);
    }
    const text = result.handlerResult.metadata?.text;
    if (typeof text !== "string" || !text.trim()) return;
    await guard.deliver(result.route.sessionId, {
      actionId: `mock-final:${event.message.id}`,
      transport: "mock",
      accountId: event.accountId,
      peer: event.peer,
      message: {
        text,
        replyToMessageId: event.message.id,
      },
    });
  });

  await mock.emit({
    eventId: "mock:live-codex:1",
    transport: "mock",
    accountId: "default",
    peer: { kind: "dm", id: "peer-live" },
    sender: { id: "user-live", displayName: "Live Smoke" },
    message: {
      id: "live-codex-1",
      text:
        "실제 라이브 스모크입니다. 이 요청을 반드시 dispatch_worker로 보내서 백그라운드 워커 작업으로 시작해 주세요. 작업 내용은 live codex smoke marker 확인입니다.",
      timestamp: new Date().toISOString(),
    },
  });

  const originPath = join(tempDir, "tasks", "live-codex-smoke-task", "origin.json");
  const sentTexts = mock.sentActions.map((action) => action.message.text || "");
  if (!existsSync(originPath)) {
    throw new Error("origin.json was not created; model likely did not call dispatch_worker");
  }
  if (!sentTexts.some((text) => expectedStartTexts.some((expected) => text.includes(expected)))) {
    throw new Error(`missing pre-dispatch progress delivery: ${JSON.stringify(sentTexts)}`);
  }
  if (!sentTexts.some((text) => expectedCompleteTexts.some((expected) => text.includes(expected)))) {
    throw new Error(`missing dispatch-complete delivery: ${JSON.stringify(sentTexts)}`);
  }

  const origin = JSON.parse(readFileSync(originPath, "utf8"));
  console.log(JSON.stringify({
    ok: true,
    sentCount: mock.sentActions.length,
    sentTexts,
    origin: {
      origin_session_id: origin.origin_session_id,
      origin_message_id: origin.origin_message_id,
      origin_inbound_event_id: origin.origin_inbound_event_id,
      task_summary: origin.task_summary,
    },
  }, null, 2));
} finally {
  if (previousButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = previousButlerData;
  rmSync(tempDir, { recursive: true, force: true });
}
