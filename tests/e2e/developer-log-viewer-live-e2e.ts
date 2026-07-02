import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptAssembler } from "../../packages/butler-agent/src/agent/prompt/prompt-assembler.ts";
import { NativeToolLoopRuntime } from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import { createGatewayServer } from "../../packages/butler-agent/src/gateways/core/server.ts";
import { GatewayRouter } from "../../packages/butler-agent/src/gateways/core/router.ts";
import { createAppServer } from "../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts";
import { createLifecycleGatewayHandlers, SessionLifecycleService } from "../../packages/butler-agent/src/interfaces/gateway/session-lifecycle.ts";
import { loadPrivateEnvIntoProcess } from "../../packages/butler-agent/src/interfaces/cli/private-env.ts";
import { runFunctionToolPromptText, type FunctionToolPromptOptions } from "../../packages/butler-agent/src/integrations/providers/provider.ts";
import { DeliveryGuard } from "../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts";
import { MockTransportAdapter } from "../../packages/butler-agent/src/interfaces/transport/mock/adapter.ts";
import { DeveloperLogStore } from "../../packages/butler-agent/src/operations/diagnostics/developer-log-store.ts";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import type { ModelProviderAdapter } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import type { DeveloperLogListView } from "../../packages/butler-agent/src/gateways/app/interface/protocol/runtime-contract.ts";

const butlerHome = process.env.BUTLER_HOME || process.cwd();
const previousButlerData = process.env.BUTLER_DATA;
const previousRuntime = process.env.BUTLER_RUNTIME;
const sourceButlerData = process.env.BUTLER_LIVE_SOURCE_BUTLER_DATA ||
  previousButlerData ||
  join(process.env.HOME ?? "", ".butler");
const tempDir = mkdtempSync(join(tmpdir(), "butler-devlog-live-e2e-"));
const model = normalizeE2eModel(
  process.env.BUTLER_DEVLOG_E2E_MODEL || "openai/gpt-5.5",
);
const reasoningEffort = process.env.BUTLER_DEVLOG_E2E_REASONING || "low";
const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const answerToken = `LIVE_DEVLOG_E2E_${runId}`;
const secretToken = `devlog-secret-${runId}`;

const provider: ModelProviderAdapter = {
  id: "developer-log-live-e2e",
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

const capturedPrompts: string[] = [];
let liveModelCalls = 0;

try {
  loadPrivateEnvIntoProcess(sourceButlerData);
  process.env.BUTLER_HOME = butlerHome;
  process.env.BUTLER_DATA = tempDir;
  process.env.BUTLER_RUNTIME ||= "codex-api";

  assert(model === "openai/gpt-5.5", `Developer log live E2E must use GPT-5.5, got ${model}`);
  assert(
    reasoningEffort === "low" || reasoningEffort === "medium",
    `Developer log live E2E reasoning must be low or medium, got ${reasoningEffort}`,
  );

  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const runtime = new NativeToolLoopRuntime({
    butlerHome,
    butlerData: tempDir,
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    runFunctionToolPromptText: async (input: FunctionToolPromptOptions) => {
      liveModelCalls += 1;
      capturedPrompts.push(input.prompt);
      return await runFunctionToolPromptText(input);
    },
  });
  const developerLogStore = new DeveloperLogStore({ butlerData: tempDir });

  store.upsert({
    sessionId: "butler/developer-log-live",
    role: "butler",
    projectId: "butler",
    workspacePath: butlerHome,
    runtimeAdapterId: runtime.id,
    modelProviderId: provider.id,
    modelRef: model,
    transportBindings: [{
      transport: "mock",
      accountId: "default",
      peerId: "peer-devlog-live",
    }],
    metadata: {
      reasoning_effort: reasoningEffort,
    },
  });

  const mock = new MockTransportAdapter({ id: "mock" });
  const guard = new DeliveryGuard({ adapters: [mock] });
  const router = new GatewayRouter({ store });
  const lifecycle = new SessionLifecycleService({
    store,
    runtime,
    provider,
    promptAssembler: new PromptAssembler({ butlerHome, butlerData: tempDir }),
    developerLogStore,
    developerDiagnosticsEnabled: () => true,
    sessionTitleGenerator: false,
    deliverIntermediate: async ({ binding, action, metadata }) => {
      await guard.deliver(binding.sessionId, action, metadata);
    },
  });
  const gatewayServer = createGatewayServer({
    router,
    handlers: createLifecycleGatewayHandlers(lifecycle),
  });

  await mock.start(async (event) => {
    const result = await gatewayServer.handleInbound(event);
    if (result.status !== "handled") throw new Error(`not handled: ${result.status}`);
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
    eventId: "mock:developer-log-live",
    transport: "mock",
    accountId: "default",
    peer: { kind: "dm", id: "peer-devlog-live" },
    sender: { id: "user-devlog-live", displayName: "Developer Log Live E2E" },
    message: {
      id: "developer-log-live-message",
      text: [
        `답변은 반드시 ${answerToken} 만 출력해 주세요.`,
        `진단 마스킹 확인용 텍스트 OPENAI_API_KEY=${secretToken} 를 포함합니다.`,
      ].join("\n"),
      timestamp: new Date().toISOString(),
    },
    routingHints: { turnId: "turn-devlog-live" },
  });

  const sentTexts = mock.sentActions.map((action) => action.message.text || "").filter(Boolean);
  const logList = developerLogStore.list({ query: answerToken });
  const entry = logList.entries[0];
  assert(liveModelCalls >= 1, `expected at least one real model call, observed ${liveModelCalls}`);
  assert(sentTexts.some((text) => text.includes(answerToken)), `final answer did not include token: ${JSON.stringify(sentTexts)}`);
  assert(capturedPrompts.some((prompt) => prompt.includes(answerToken)), "live model prompt did not include requested answer token");
  assert(entry, `developer log entry was not written: ${JSON.stringify(logList)}`);
  assert(entry.request.input_text.includes("[REDACTED]"), "developer log did not redact request secret");
  assert(!entry.request.input_text.includes(secretToken), "developer log leaked request secret");
  assert(entry.context.sections.length > 0, "developer log did not include context sections");
  assert(entry.context.prompt_context.includes(answerToken), "developer log did not include rendered prompt context");
  assert(entry.model.requested_model_ref === model, `developer log model mismatch: ${entry.model.requested_model_ref}`);

  const appServer = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    butlerHome,
    port: 0,
  });
  try {
    const disabled = await fetch(`${appServer.url}developer-logs`);
    assert(disabled.status === 403, `developer logs should be gated, got ${disabled.status}`);
    await fetch(`${appServer.url}settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ diagnostics_enabled: true }),
    });
    const enabled = await fetch(`${appServer.url}developer-logs?query=${encodeURIComponent(answerToken)}`);
    assert(enabled.ok, `developer logs API failed: ${enabled.status}`);
    const body = await enabled.json() as { data?: DeveloperLogListView };
    assert(body.data?.entries.length === 1, `developer logs API returned unexpected body: ${JSON.stringify(body)}`);
    assert(body.data.entries[0]?.context.prompt_context.includes(answerToken), "developer logs API omitted prompt context");
  } finally {
    appServer.stop();
  }

  const logPath = join(tempDir, "app", "developer-logs", "model-turns.jsonl");
  assert(existsSync(logPath), "developer log JSONL file was not created");

  console.log(JSON.stringify({
    ok: true,
    service: "developer-log-viewer-live-e2e",
    model,
    reasoningEffort,
    liveModelCalls,
    answerToken,
    developerLogEntries: logList.total,
    contextSections: entry.context.sections.length,
    apiGateVerified: true,
  }, null, 2));
} finally {
  if (previousButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = previousButlerData;
  if (previousRuntime === undefined) delete process.env.BUTLER_RUNTIME;
  else process.env.BUTLER_RUNTIME = previousRuntime;
  rmSync(tempDir, { recursive: true, force: true });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function normalizeE2eModel(value: string): `${string}/${string}` {
  const trimmed = value.trim();
  if (trimmed === "gpt-5.5") return "openai/gpt-5.5";
  if (trimmed.includes("/")) return trimmed as `${string}/${string}`;
  throw new Error(`Developer log live E2E model must be provider/model, got ${value}`);
}
