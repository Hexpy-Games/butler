#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConversationStore } from
  "../../packages/butler-agent/src/agent/conversation/store.ts";
import { PromptAssembler } from
  "../../packages/butler-agent/src/agent/prompt/prompt-assembler.ts";
import { createProductionBtccComposition } from
  "../../packages/butler-agent/src/agent/composition/index.ts";
import {
  BtccGatewayLifecycleService,
  BtccInboundDispatcher,
  bindBtccGatewayRuntime,
  createBtccQueueEntryDecider,
  createBtccGatewayHandlers,
  type BtccQueueEntryDecider,
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
type PublicTurn = { state?: string };

export async function runWindowsAppBtccProductHarness(
  options: { browser?: boolean } = {},
): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), "butler-windows-app-btcc-"));
  const dbPath = join(root, "app.sqlite");
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
  let modelCalls = 0;
  const btcc = createProductionBtccComposition({
    butlerHome: process.cwd(),
    butlerData: root,
    appMessageDbPath: dbPath,
    ownerId: `windows-product-harness:${process.pid}`,
    promptRunner: async () => {
      modelCalls += 1;
      return "안녕하세요. 반갑습니다.";
    },
  });
  const conversations = new AgentConversationStore({ butlerData: root });
  const lifecycle = new BtccGatewayLifecycleService({
    store: bindings,
    conversationStore: conversations,
    butlerData: root,
    ...bindBtccGatewayRuntime(btcc),
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
  const decideEntry = createBtccQueueEntryDecider(dbPath);
  const deliveryGuard = new DeliveryGuard({
    adapters: [createAppTransportAdapter()],
    butlerData: root,
  });
  let browser: Awaited<ReturnType<typeof launchWindowsAppBrowser>> | null = null;

  try {
    await btcc.ready;
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
      queue, gateway, bindings, deliveryGuard, decideEntry,
    });
    if (browser) await browser.waitForFinalCount(1);
    const chatId = browser ? await latestChatId(app.url) : "general";
    if (browser) await browser.send("앞선 대화에 이어 두 번째로 답해주세요.");
    else await postMessage(app.url, "앞선 대화에 이어 두 번째로 답해주세요.");
    const secondDispatch = await waitAndDispatchOne(dispatcher, {
      queue, gateway, bindings, deliveryGuard, decideEntry,
    });
    const browserFinalCount = browser ? await browser.waitForFinalCount(2) : null;
    const browserReload = browser ? await browser.reloadAndVerify(2) : null;
    await browser?.close();
    browser = null;
    const before = await waitForCanonicalSnapshot(app.url, chatId);
    await btcc.close();
    app.stop();
    app = createAppServer({
      dbPath,
      butlerData: root,
      butlerHome: process.cwd(),
      port: 0,
      automationSchedulerIntervalMs: false,
    });
    const after = await waitForCanonicalSnapshot(app.url, chatId);
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
      after.turnState === "delivered";
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
      modelCalls,
      rawTextIncluded: false,
    };
    if (
      !result.ok || !result.deterministicConversation || !result.canonicalProjection ||
      (options.browser && result.browserProjection !== true)
    ) {
      const restartDiagnostics = {
        before: before.messages.map(messageIdentity),
        after: after.messages.map(messageIdentity),
      };
      throw new Error(
        `App BTCC product harness failed: ${JSON.stringify({
          result,
          restartDiagnostics,
        })}`,
      );
    }
    return result;
  } finally {
    await browser?.close();
    await btcc.close();
    app.stop();
    conversations.close();
    bindings.close();
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
    decideEntry: BtccQueueEntryDecider;
  },
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const summary = dispatcher.poll({
      queue: input.queue,
      server: input.gateway,
      store: input.bindings,
      deliveryGuard: input.deliveryGuard,
      decideEntry: input.decideEntry,
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

async function latestChatId(url: string): Promise<string> {
  const navigation = await get(`${url}navigation`);
  const chats = array(navigation.data?.chats);
  for (const value of chats) {
    const chat = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    if (typeof chat.id === "string" && chat.id !== "general") return chat.id;
  }
  throw new Error("Electron did not create an App conversation");
}

async function publicSnapshot(url: string, chatId: string) {
  const [view, messages, summary, turns] = await Promise.all([
    get(`${url}session-view?session_id=${encodeURIComponent(chatId)}`),
    get(`${url}messages?chat_id=${encodeURIComponent(chatId)}&cursor=0`),
    get(`${url}session-summary?session_id=${encodeURIComponent(chatId)}`),
    get(`${url}turns?chat_id=${encodeURIComponent(chatId)}&cursor=0`),
  ]);
  const viewMessages = array((view.data?.messages)).map(publicMessage);
  const replayMessages = array((messages.data?.messages)).map(publicMessage);
  const appTurns = array(turns.data?.turns).map(publicTurn);
  return {
    messages: replayMessages,
    viewMessageIds: viewMessages.map((message) => message.id ?? ""),
    messageIds: replayMessages.map((message) => message.id ?? ""),
    turnState: summary.data?.turn_state,
    appTurnStates: appTurns.map((turn) => turn.state),
  };
}

async function waitForCanonicalSnapshot(url: string, chatId: string) {
  const deadline = Date.now() + 5_000;
  let snapshot = await publicSnapshot(url, chatId);
  while (
    Date.now() < deadline &&
    (
      snapshot.viewMessageIds.join("|") !== snapshot.messageIds.join("|") ||
      snapshot.turnState !== "delivered" ||
      snapshot.appTurnStates.length !== 2 ||
      snapshot.appTurnStates.some((state) => state !== "delivered")
    )
  ) {
    await Bun.sleep(25);
    snapshot = await publicSnapshot(url, chatId);
  }
  return snapshot;
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

function publicTurn(value: unknown): PublicTurn {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as PublicTurn
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function sameMessages(left: PublicMessage[], right: PublicMessage[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function messageIdentity(message: PublicMessage): Record<string, unknown> {
  const diagnostic = Object.fromEntries(
    Object.entries(message).filter(([key]) => key !== "text"),
  );
  return {
    ...diagnostic,
    textLength: message.text?.length,
  };
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
