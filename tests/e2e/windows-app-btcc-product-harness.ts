#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConversationStore } from
  "../../packages/butler-agent/src/agent/conversation/store.ts";
import { PromptAssembler } from
  "../../packages/butler-agent/src/agent/prompt/prompt-assembler.ts";
import { createBtccTurnRuntime } from
  "../../packages/butler-agent/src/agent/btcc/index.ts";
import { openBtccSqliteStores } from
  "../../packages/butler-agent/src/agent/adapters/index.ts";
import { BtccTurnProgressHub } from
  "../../packages/butler-agent/src/agent/composition/production-btcc/index.ts";
import { DirectHarnessModel } from
  "../../packages/butler-agent/src/interfaces/btcc-harness/direct-harness-model.ts";
import { HarnessArtifactWorkspace } from
  "../../packages/butler-agent/src/interfaces/btcc-harness/harness-artifact-workspace.ts";
import { HarnessOperationExecutor } from
  "../../packages/butler-agent/src/interfaces/btcc-harness/harness-operation-executor.ts";
import {
  BtccGatewayLifecycleService,
  BtccInboundDispatcher,
  createBtccGatewayHandlers,
} from "../../packages/butler-agent/src/interfaces/gateway/btcc/index.ts";
import { createAppTransportAdapter } from
  "../../packages/butler-agent/src/interfaces/transport/app/adapter.ts";
import { DeliveryGuard } from
  "../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts";
import { createGatewayServer } from
  "../../packages/butler-agent/src/gateways/core/server.ts";
import { GatewayRouter } from
  "../../packages/butler-agent/src/gateways/core/router.ts";
import { NativeInboundQueue } from
  "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";
import { createAppServer } from
  "../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts";
import { SessionBindingStore } from
  "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { launchWindowsAppBrowser } from
  "../../packages/butler-app/scripts/windows/windows-app-browser-harness.ts";

type ApiEnvelope = { data?: Record<string, unknown> };
type PublicMessage = { id?: string; role?: string; text?: string; turn_id?: string };

export async function runWindowsAppBtccProductHarness(
  options: { browser?: boolean } = {},
): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), "butler-windows-app-btcc-"));
  const dbPath = join(root, "app.sqlite");
  const btccPath = join(root, "runtime", "btcc-successor.sqlite");
  markExecutorReady(root);
  const bindings = new SessionBindingStore(
    join(root, "runtime", "session-store.sqlite"),
    "ephemeral",
  );
  let app = createAppServer({
    dbPath,
    butlerData: root,
    butlerHome: process.cwd(),
    port: 0,
    automationSchedulerIntervalMs: false,
    sessionBindingStore: bindings,
  });
  const stores = openBtccSqliteStores({
    dbPath: btccPath,
    ownerId: `windows-product-harness:${process.pid}`,
    storageProfile: "ephemeral",
  });
  const progress = new BtccTurnProgressHub();
  const model = new DirectHarnessModel();
  const runtime = createBtccTurnRuntime({
    admission: stores.admission,
    turns: stores.turns,
    phaseConversations: stores.phaseConversations,
    model,
    operations: new HarnessOperationExecutor(root),
    artifacts: new HarnessArtifactWorkspace(),
    messages: stores.messages,
    retrospective: stores.retrospective,
    operationalRecovery: stores.operationalRecovery,
    committedSuccessorReadiness: stores.committedSuccessorReadiness,
    progress,
  });
  const conversations = new AgentConversationStore({ butlerData: root });
  const lifecycle = new BtccGatewayLifecycleService({
    store: bindings,
    conversationStore: conversations,
    butlerData: root,
    runtime,
    contextDocuments: stores.contextDocuments,
    observeTurn: (turnId, observer) => progress.observe(turnId, observer),
    promptAssembler: new PromptAssembler({ butlerHome: process.cwd(), butlerData: root }),
    generateSessionTitle: async () => null,
  });
  const gateway = createGatewayServer({
    router: new GatewayRouter({ store: bindings }),
    handlers: createBtccGatewayHandlers(lifecycle),
    butlerData: root,
  });
  const dispatcher = new BtccInboundDispatcher();
  const queue = new NativeInboundQueue(root);
  const deliveryGuard = new DeliveryGuard({ adapters: [createAppTransportAdapter()] });
  let browser: Awaited<ReturnType<typeof launchWindowsAppBrowser>> | null = null;

  try {
    browser = options.browser
      ? await launchWindowsAppBrowser({
        repoRoot: process.cwd(),
        serverUrl: app.url,
        dataRoot: root,
      })
      : null;
    if (browser) await browser.send("첫 번째 Windows BTCC 메시지입니다.");
    else await postMessage(app.url, "첫 번째 Windows BTCC 메시지입니다.");
    const firstDispatch = await waitAndDispatchOne(dispatcher, {
      queue, gateway, bindings, deliveryGuard,
    });
    if (browser) await browser.waitForFinalCount(1);
    if (browser) await browser.send("앞선 대화에 이어 두 번째로 답해주세요.");
    else await postMessage(app.url, "앞선 대화에 이어 두 번째로 답해주세요.");
    const secondDispatch = await waitAndDispatchOne(dispatcher, {
      queue, gateway, bindings, deliveryGuard,
    });
    const browserFinalCount = browser ? await browser.waitForFinalCount(2) : null;
    const browserReload = browser ? await browser.reloadAndVerify(2) : null;
    await browser?.close();
    browser = null;
    const before = await publicSnapshot(app.url);
    app.stop();
    app = createAppServer({
      dbPath,
      butlerData: root,
      butlerHome: process.cwd(),
      port: 0,
      automationSchedulerIntervalMs: false,
    });
    const after = await publicSnapshot(app.url);
    const assistant = after.messages.filter((message) => message.role === "assistant");
    const user = after.messages.filter((message) => message.role === "user");
    const turnCount = new Set(
      after.messages.map((message) => message.turn_id).filter(Boolean),
    ).size;
    const appIngress =
      firstDispatch.handled === 1 && secondDispatch.handled === 1 && turnCount === 2;
    const deterministicConversation =
      assistant.length === 2 &&
      assistant.every((message) => message.text === "안녕하세요. 반갑습니다.");
    const conversationContinuity =
      user.map((message) => message.text).join("\n").includes("앞선 대화에 이어") &&
      turnCount === 2;
    const canonicalProjection =
      after.viewMessageIds.join("|") === after.messageIds.join("|") &&
      typeof after.turnState === "string";
    const restartDataReload = sameMessages(before.messages, after.messages);
    const browserProjection = options.browser
      ? browserFinalCount === 2 && browserReload === true
      : null;
    const result = {
      ok:
        firstDispatch.handled === 1 && firstDispatch.delivered === 1 &&
        secondDispatch.handled === 1 && secondDispatch.delivered === 1 &&
        user.length === 2 && assistant.length === 2 && appIngress &&
        deterministicConversation && conversationContinuity && canonicalProjection &&
        restartDataReload && (!options.browser || browserProjection === true),
      appIngress,
      deterministicConversation,
      conversationContinuity,
      canonicalProjection,
      restartDataReload,
      browserProjection,
      modelCalls: model.callCount,
      rawTextIncluded: false,
    };
    if (
      !result.ok || !result.deterministicConversation || !result.canonicalProjection ||
      (options.browser && result.browserProjection !== true)
    ) {
      throw new Error(`App BTCC product harness failed: ${JSON.stringify(result)}`);
    }
    return result;
  } finally {
    await browser?.close();
    app.stop();
    conversations.close();
    bindings.close();
    await stores.retrospective.flush();
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function waitAndDispatchOne(
  dispatcher: BtccInboundDispatcher,
  input: {
    queue: NativeInboundQueue;
    gateway: ReturnType<typeof createGatewayServer>;
    bindings: SessionBindingStore;
    deliveryGuard: DeliveryGuard;
  },
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const summary = dispatcher.poll({
      queue: input.queue,
      server: input.gateway,
      store: input.bindings,
      deliveryGuard: input.deliveryGuard,
      limit: 1,
    });
    if (summary.claimed > 0) {
      await dispatcher.waitForIdle();
      return summary;
    }
    await Bun.sleep(25);
  }
  throw new Error("App browser message did not reach the BTCC inbound queue");
}

async function postMessage(url: string, text: string) {
  const response = await fetch(`${url}messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: "general", text }),
  });
  const body = await response.json() as ApiEnvelope;
  if (response.status !== 202) throw new Error(`App message ingress failed: ${response.status}`);
  return { turnId: (body.data?.turn as Record<string, unknown> | undefined)?.id };
}

async function publicSnapshot(url: string) {
  const [view, messages, summary] = await Promise.all([
    get(`${url}session-view?session_id=general`),
    get(`${url}messages?chat_id=general&cursor=0`),
    get(`${url}session-summary?session_id=general`),
  ]);
  const viewMessages = array((view.data?.messages)).map(publicMessage);
  const replayMessages = array((messages.data?.messages)).map(publicMessage);
  return {
    messages: replayMessages,
    viewMessageIds: viewMessages.map((message) => message.id ?? ""),
    messageIds: replayMessages.map((message) => message.id ?? ""),
    turnState: summary.data?.turn_state,
  };
}

async function get(url: string): Promise<ApiEnvelope> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`App projection read failed: ${response.status}`);
  return await response.json() as ApiEnvelope;
}

function publicMessage(value: unknown): PublicMessage {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as PublicMessage
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function sameMessages(left: PublicMessage[], right: PublicMessage[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function markExecutorReady(root: string): void {
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "butler-main-native.json"), JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    runtime: "windows-product-harness",
    launcher: "windows-app-btcc-product-harness",
  }));
}

if (import.meta.main) {
  process.stdout.write(`${JSON.stringify(await runWindowsAppBtccProductHarness({
    browser: process.argv.includes("--browser"),
  }))}\n`);
}
