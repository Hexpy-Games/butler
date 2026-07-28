import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  DeliveryResult,
  ModelProviderAdapter,
  OutboundAction,
} from "../../test-support/harness/contracts.ts";
import {
  recordSessionLifecycle,
  recordSystemEvent,
} from "../../test-support/harness/durable-session-transcript.ts";
import { SessionBindingStore } from "../../test-support/harness/session-store.ts";
import { GatewayRouter } from "../../gateways/core/router.ts";
import { createGatewayServer } from "../../gateways/core/server.ts";
import { PromptAssembler } from "../../agent/prompt/prompt-assembler.ts";
import { generateSessionTitleWithProvider } from "../../agent/output/session-title.ts";
import { diagnosticDetails, safeRuntimeFailure } from "../../integrations/providers/provider-errors.ts";
import { DeliveryGuard } from "../transport/delivery-guard.ts";
import { createAppTransportAdapter } from "../transport/app/adapter.ts";
import { NativeInboundQueue } from "../../gateways/core/inbound-queue.ts";
import {
  resolveTelegramGatewayRuntimeConfig,
} from "../../operations/gateway/registry.ts";
import { createProductionBtccComposition } from "../../agent/composition/index.ts";
import { AgentConversationStore } from "../../agent/conversation/store.ts";
import {
  BtccInboundDispatcher,
  BtccGatewayLifecycleService,
  BtccStopRequestReconciler,
  bindBtccGatewayRuntime,
  createBtccGatewayHandlers,
  type BtccGatewayRuntime,
} from "./btcc/index.ts";
import {
  appTurnEventAction,
  appTurnStateDbPath,
  bindButlerSession,
  createNativeButlerDefaultProvider,
  persistButlerSessionPointer,
  readButlerConfig,
  requireModelRef,
  resolveButlerData,
  resolveButlerHome,
  resolveButlerSession,
  sendStartupNotification,
  shouldEnterBtcc,
  startupMessage,
  statusText,
  waitForShutdown,
  writeStartupGraceMarker,
} from "./native-butler/index.ts";
import {
  clearAppForegroundExecutorReadiness,
  publishAppForegroundExecutorReadiness,
} from "../../operations/service/app-foreground-readiness.ts";


export interface NativeButlerMainOptions {
  butlerHome?: string;
  butlerData?: string;
  btcc?: BtccGatewayRuntime;
  provider?: ModelProviderAdapter;
  sendTelegram?: (input: {
    chatId: string;
    text: string;
    threadId?: string;
  }) => Promise<DeliveryResult>;
  shutdownSignal?: AbortSignal;
  shutdownPollMs?: number;
  enableTelegramPolling?: boolean;
  waitForShutdown?: boolean;
}

export interface NativeButlerMainResult {
  sessionId: string;
  startupMessage: string;
  startupDelivery?: DeliveryResult;
  shutdownReason: "signal" | "flag" | "bootstrap-only";
}

export { appTurnEventAction, createNativeButlerDefaultProvider };

export async function runNativeButlerMain(
  input: NativeButlerMainOptions = {},
): Promise<NativeButlerMainResult> {
  const butlerHome = resolveButlerHome(input.butlerHome);
  const butlerData = resolveButlerData(input.butlerData);
  const config = readButlerConfig(butlerData);
  const telegramGateway = resolveTelegramGatewayRuntimeConfig({
    butlerData,
    compatibilityConfig: config as Record<string, any>,
  });
  const appMessageDbPath = appTurnStateDbPath(butlerData);
  const btcc = input.btcc ?? createProductionBtccComposition({
    butlerHome,
    butlerData,
    appMessageDbPath,
    ownerId: `native-butler:${process.pid}`,
  });
  if ("ready" in btcc && btcc.ready) await btcc.ready;
  const provider = input.provider ?? createNativeButlerDefaultProvider(config);
  const store = new SessionBindingStore(join(butlerData, "runtime", "session-store.sqlite"));
  const conversationStore = new AgentConversationStore({ butlerData });
  const shutdownFlagPath = join(butlerData, "locks", "butler-shutdown");
  const pollMs = input.shutdownPollMs ?? 500;

  let sessionId: string | null = null;
  let stopTelegramPolling = false;
  let telegramPolling: Promise<void> | undefined;
  let stopReconciler: BtccStopRequestReconciler | undefined;
  const inboundDispatcher = new BtccInboundDispatcher();
  const inboundQueue = new NativeInboundQueue(butlerData);
  const serviceShouldStop = () =>
    stopTelegramPolling || input.shutdownSignal?.aborted || existsSync(shutdownFlagPath);
  const currentTelegramGateway = () =>
    resolveTelegramGatewayRuntimeConfig({
      butlerData,
      compatibilityConfig: readButlerConfig(butlerData) as Record<string, any>,
    });
  const telegramShouldStop = () => serviceShouldStop() || !currentTelegramGateway().enabled;
  try {
    sessionId = resolveButlerSession(store, butlerData);
    const binding = bindButlerSession({
      store,
      sessionId,
      butlerHome,
      butlerData,
      provider,
    });
    persistButlerSessionPointer(butlerData, binding.sessionId);

    const router = new GatewayRouter({ store });
    const telegramAdapter = telegramGateway.enabled
      ? (await import("../transport/telegram/adapter.ts"))
        .createTelegramTransportAdapter({
          butlerHome,
          sendTelegram: input.sendTelegram,
        })
      : null;
    const appAdapter = createAppTransportAdapter();
    const deliveryGuard = new DeliveryGuard({
      adapters: telegramAdapter ? [telegramAdapter, appAdapter] : [appAdapter],
    });
    const deliverThroughEnabledGate = async (
      activeSessionId: string,
      action: OutboundAction,
      metadata: Record<string, unknown>,
    ): Promise<DeliveryResult> => {
      if (action.transport === "telegram" && !currentTelegramGateway().enabled) {
        return {
          ok: false,
          error: "Telegram gateway disabled",
        };
      }
      return await deliveryGuard.deliver(activeSessionId, action, metadata);
    };
    const lifecycle = new BtccGatewayLifecycleService({
      store,
      conversationStore,
      butlerData,
      ...bindBtccGatewayRuntime(btcc),
      promptAssembler: new PromptAssembler({
        butlerHome,
        butlerData,
      }),
      generateSessionTitle: ({ binding: activeBinding, envelope }) =>
        generateSessionTitleWithProvider(provider, {
          text: envelope.message.text ?? "",
          model: requireModelRef(activeBinding.modelRef),
          signal: envelope.signal,
        }),
      deliverTurnEvent: async ({ binding: activeBinding, envelope, event }) => {
        const action = appTurnEventAction({
          sessionId: activeBinding.sessionId,
          envelope,
          event,
        });
        if (!action) return;
        const delivery = await deliverThroughEnabledGate(activeBinding.sessionId, action, {
          source: "gateway/native-butler-bootstrap.ts#turn-event",
          kind: "turn_event",
          turnId: envelope.routingHints?.turnId,
        });
        if (!delivery.ok) {
          throw new Error(delivery.error || "App turn event delivery failed");
        }
      },
    });
    stopReconciler = new BtccStopRequestReconciler(appMessageDbPath, btcc.runtime);
    await stopReconciler.reconcile();
    await lifecycle.getOrCreate(binding.sessionId, "butler");
    const recoverableInbound = shouldEnterBtcc(butlerData);
    const recovered = inboundQueue.recoverRuntimeInterruptions(
      recoverableInbound,
    );
    if (recovered.requeued > 0) {
      process.stdout.write(
        `[inbound-queue] recovered-runtime-interruptions=${recovered.requeued}\n`,
      );
    }
    const server = createGatewayServer({
      router,
      handlers: createBtccGatewayHandlers(lifecycle),
      butlerData,
    });
    if (telegramAdapter) {
      const [{ createTelegramLiveGateway }, { runTelegramPolling }] =
        await Promise.all([
          import("../transport/telegram/live-gateway.ts"),
          import("../transport/telegram/polling-runner.ts"),
        ]);
      const gateway = createTelegramLiveGateway({
        adapter: telegramAdapter,
        router,
        server,
        renderStatus: () => statusText({
          sessionId: binding.sessionId,
          modelRef: binding.modelRef,
          butlerData,
        }),
      });
      await gateway.start();
      telegramPolling = input.enableTelegramPolling === false
        ? undefined
        : runTelegramPolling({
          butlerData,
          gateway,
          shouldStop: telegramShouldStop,
          log: (line) => {
            process.stdout.write(`[telegram] ${line}\n`);
          },
        });
    }
    writeStartupGraceMarker(butlerData);
    const startupText = startupMessage(binding.modelRef);
    const startupDelivery = telegramGateway.enabled ? await sendStartupNotification({
      butlerHome,
      chatId: telegramGateway.chatId ?? undefined,
      sessionId: binding.sessionId,
      message: startupText,
      sendTelegram: input.sendTelegram,
    }) : undefined;
    publishAppForegroundExecutorReadiness(butlerData);

    let shutdownReason: NativeButlerMainResult["shutdownReason"] = "bootstrap-only";
    if (input.waitForShutdown !== false) {
      shutdownReason = await waitForShutdown({
        shutdownFlagPath,
        signal: input.shutdownSignal,
        pollMs,
        onPoll: async () => {
          await stopReconciler?.reconcile();
          const summary = inboundDispatcher.poll({
            queue: inboundQueue,
            server,
            store,
            deliveryGuard,
            deliverAction: deliverThroughEnabledGate,
            shouldHandleItem: recoverableInbound,
            limit: 5,
            maxConcurrentSessions: 5,
            onOutcome: (outcome) => {
              process.stdout.write(
                `[inbound-queue] completed queueId=${outcome.queueId} handled=${outcome.handled} delivered=${outcome.delivered} failed=${outcome.failed} interrupted=${outcome.interrupted}\n`,
              );
            },
          });
          if (summary.claimed > 0) {
            process.stdout.write(`[inbound-queue] claimed=${summary.claimed} started=${summary.claimed}\n`);
          }
        },
      });
      await Promise.race([
        inboundDispatcher.waitForIdle(),
        new Promise((resolve) => setTimeout(resolve, 12_000)),
      ]);
      stopTelegramPolling = true;
      await Promise.race([
        telegramPolling,
        new Promise((resolve) => setTimeout(resolve, 12_000)),
      ]);
      await lifecycle.closeSession(binding.sessionId, shutdownReason === "flag" ? "controlled-stop" : "native-signal");
    }

    return {
      sessionId: binding.sessionId,
      startupMessage: startupText,
      startupDelivery,
      shutdownReason,
    };
  } catch (error) {
    if (sessionId) {
      const timestamp = new Date().toISOString();
      const safeFailure = safeRuntimeFailure(error);
      store.updateLifecycleState(sessionId, "crashed", timestamp);
      recordSessionLifecycle({
        sessionId,
        role: "butler",
        state: "crashed",
        reason: "native-butler-bootstrap-error",
        metadata: {
          source: "gateway/native-butler-bootstrap.ts",
          message: safeFailure.message,
          code: safeFailure.code,
          diagnostics: diagnosticDetails(error),
        },
        timestamp,
      });
      recordSystemEvent({
        sessionId,
        category: "runtime_error",
        message: safeFailure.message,
        statusCode: safeFailure.statusCode,
        details: diagnosticDetails(error),
        metadata: {
          source: "gateway/native-butler-bootstrap.ts",
          code: safeFailure.code,
        },
        timestamp,
      });
    }
    throw error;
  } finally {
    clearAppForegroundExecutorReadiness(butlerData);
    stopTelegramPolling = true;
    stopReconciler?.close();
    await btcc.close();
    conversationStore.close();
    store.close();
  }
}
