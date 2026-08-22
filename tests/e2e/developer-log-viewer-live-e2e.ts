import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppServer } from "../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts";
import { NativeInboundQueue } from "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";
import { GatewayRouter } from "../../packages/butler-agent/src/gateways/core/router.ts";
import { createGatewayServer } from "../../packages/butler-agent/src/gateways/core/server.ts";
import { createProductionBtccComposition } from
  "../../packages/butler-agent/src/agent/composition/create-btcc-composition.ts";
import { createBtccGatewayHandlers } from
  "../../packages/butler-agent/src/interfaces/gateway/btcc/create-btcc-gateway-handlers.ts";
import { BtccInboundDispatcher } from
  "../../packages/butler-agent/src/interfaces/gateway/btcc/btcc-inbound-dispatcher.ts";
import { DeliveryGuard } from
  "../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts";
import { createAppTransportAdapter } from
  "../../packages/butler-agent/src/interfaces/transport/app/adapter.ts";
import { SessionBindingStore } from
  "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { sessionHintForRow } from
  "../../packages/butler-agent/src/gateways/app/domain/sessions/session-read-model.ts";
import { createProviderModelRoundPort } from
  "../../packages/butler-agent/src/integrations/providers/runtime.ts";
import type { ModelRoundPort } from
  "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import { loadPrivateEnvIntoProcess } from
  "../../packages/butler-agent/src/interfaces/cli/private-env.ts";
import { DeveloperLogStore } from
  "../../packages/butler-agent/src/operations/diagnostics/developer-log-store.ts";
import type { DeveloperLogListView } from
  "../../packages/butler-agent/src/gateways/app/interface/protocol/runtime-contract.ts";

const previousButlerData = process.env.BUTLER_DATA;
const previousRuntime = process.env.BUTLER_RUNTIME;
const sourceButlerData = process.env.BUTLER_LIVE_SOURCE_BUTLER_DATA ||
  previousButlerData ||
  join(process.env.HOME ?? "", ".butler");
const tempDir = mkdtempSync(join(tmpdir(), "butler-devlog-live-e2e-"));
const model = normalizeE2eModel(
  process.env.BUTLER_DEVLOG_E2E_MODEL || "openai/gpt-5.6-sol",
);
const reasoningEffort = process.env.BUTLER_DEVLOG_E2E_REASONING || "low";
const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const answerToken = `LIVE_DEVLOG_E2E_${runId}`;
const secretToken = `devlog-secret-${runId}`;
const clientMessageId = "client-devlog-live-e2e-message";

let liveModelCalls = 0;
const livePrompts: string[] = [];

try {
  loadPrivateEnvIntoProcess(sourceButlerData);
  process.env.BUTLER_DATA = tempDir;
  process.env.BUTLER_RUNTIME ||= "codex-api";

  assert(model === "openai/gpt-5.6-sol", `Developer log live E2E must use GPT-5.6 Sol, got ${model}`);
  assert(
    reasoningEffort === "low" || reasoningEffort === "medium",
    `Developer log live E2E reasoning must be low or medium, got ${reasoningEffort}`,
  );
  publishNativeReadiness(tempDir);

  const bindings = new SessionBindingStore(
    join(tempDir, "runtime", "session-store.sqlite"),
  );
  bindings.upsert({
    sessionId: sessionHintForRow("general"),
    role: "butler",
    workspacePath: tempDir,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: model,
    transportBindings: [{
      transport: "app",
      accountId: "local",
      peerId: "general",
    }],
  });

  const composition = createProductionBtccComposition({
    butlerHome: tempDir,
    butlerData: tempDir,
    ownerId: "developer-log-live-e2e",
    sessionBindings: bindings,
    modelRound: countedLiveModelRound(),
  });
  const gatewayServer = createGatewayServer({
    router: new GatewayRouter({ store: bindings }),
    handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
    butlerData: tempDir,
  });

  const appServer = createAppServer({
    dbPath: join(tempDir, "app-server", "butler-client.sqlite"),
    butlerHome: tempDir,
    butlerData: tempDir,
    port: 0,
  });
  try {
    const gated = await fetch(`${appServer.url}developer-logs`);
    assert(gated.status === 403, `developer logs should be gated while developer mode is off, got ${gated.status}`);

    const enabledSettings = await fetch(`${appServer.url}settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ diagnostics_enabled: true }),
    });
    assert(enabledSettings.ok, `settings PATCH failed: ${enabledSettings.status}`);

    const queue = new NativeInboundQueue(tempDir);
    const dispatcher = new BtccInboundDispatcher();
    const deliveryGuard = new DeliveryGuard({
      adapters: [createAppTransportAdapter()],
      butlerData: tempDir,
    });
    const submitted = await fetch(`${appServer.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        text: [
          `답변은 반드시 ${answerToken} 만 출력해 주세요.`,
          `진단 마스킹 확인용 텍스트 OPENAI_API_KEY=${secretToken} 를 포함합니다.`,
        ].join("\n"),
        model,
        reasoning_effort: reasoningEffort,
        client_message_id: clientMessageId,
      }),
    });
    assert(submitted.status === 202, `message submission failed: ${submitted.status}`);

    dispatcher.poll({
      queue,
      server: gatewayServer,
      store: bindings,
      deliveryGuard,
      limit: 4,
      maxConcurrentSessions: 1,
    });
    await dispatcher.waitForIdle();
    await waitForQueueState(
      join(tempDir, "app-server", "butler-client.sqlite"),
      clientMessageId,
      "dispatched",
    );
    assert(liveModelCalls >= 1, `expected at least one real model call, observed ${liveModelCalls}`);

    const logStore = new DeveloperLogStore({ butlerData: tempDir });
    const listed = logStore.list({ query: answerToken });
    const entry = listed.entries[0];
    assert(entry, `developer log entry was not written: total=${listed.total}`);
    assert(entry.kind === "model_turn", `unexpected entry kind: ${entry.kind}`);
    assert(entry.request.input_text.includes("[REDACTED]"), "developer log did not redact request secret");
    assert(!entry.request.input_text.includes(secretToken), "developer log leaked request secret");
    assert(entry.context.prompt_context.includes(answerToken), "developer log did not include rendered prompt context");
    assert(entry.response.text.includes(answerToken), `developer log response missed the answer token: ${entry.response.text.slice(0, 200)}`);
    assert(entry.model.requested_model_ref === model, `developer log model mismatch: ${entry.model.requested_model_ref}`);
    assert(livePrompts.some((prompt) => prompt.includes(answerToken)), "live model prompt did not include requested answer token");

    const apiView = await fetch(
      `${appServer.url}developer-logs?query=${encodeURIComponent(answerToken)}`,
    );
    assert(apiView.ok, `developer logs API failed after enabling developer mode: ${apiView.status}`);
    const body = await apiView.json() as { data?: DeveloperLogListView };
    assert(body.data?.entries.length === 1, `developer logs API returned unexpected body: ${JSON.stringify(body.data?.pagination)}`);
    assert(body.data.entries[0]?.context.prompt_context.includes(answerToken), "developer logs API omitted prompt context");
    assert(body.data.developer_mode_enabled === true, "developer logs API did not report developer mode enabled");

    const logPath = join(tempDir, "app", "developer-logs", "model-turns.jsonl");
    assert(existsSync(logPath), "developer log JSONL file was not created");

    console.log(JSON.stringify({
      ok: true,
      service: "developer-log-viewer-live-e2e",
      model,
      reasoningEffort,
      liveModelCalls,
      answerToken,
      developerLogEntries: listed.total,
      contextSections: entry.context.sections.length,
      apiGateVerified: true,
    }, null, 2));
  } finally {
    appServer.stop();
    await composition.host.close();
  }
} finally {
  if (previousButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = previousButlerData;
  if (previousRuntime === undefined) delete process.env.BUTLER_RUNTIME;
  else process.env.BUTLER_RUNTIME = previousRuntime;
  rmSync(tempDir, { recursive: true, force: true });
}

function countedLiveModelRound(): ModelRoundPort {
  const live = createProviderModelRoundPort();
  return {
    async runRound(request) {
      liveModelCalls += 1;
      livePrompts.push(request.messages.map((message) => message.content).join("\n"));
      return await live.runRound(request);
    },
    initialRequestBytes: live.initialRequestBytes?.bind(live),
    statelessMessageBytes: live.statelessMessageBytes?.bind(live),
  };
}

function publishNativeReadiness(root: string): void {
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "state", "butler-main-native.json"),
    JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      runtime: "developer-log-live-e2e",
      launcher: "e2e",
    }),
    "utf8",
  );
}

async function waitForQueueState(
  dbPath: string,
  queuedClientMessageId: string,
  state: string,
): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.query<{ state: string }, [string]>(
        "SELECT state FROM session_queued_messages WHERE client_message_id = ?",
      ).get(queuedClientMessageId);
      if (row?.state === state) return;
    } finally {
      db.close();
    }
    await Bun.sleep(250);
  }
  throw new Error(`Queue state did not become ${state}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function normalizeE2eModel(value: string): `${string}/${string}` {
  const trimmed = value.trim();
  if (trimmed === "gpt-5.6-sol") return "openai/gpt-5.6-sol";
  if (trimmed.includes("/")) return trimmed as `${string}/${string}`;
  throw new Error(`Developer log live E2E model must be provider/model, got ${value}`);
}
