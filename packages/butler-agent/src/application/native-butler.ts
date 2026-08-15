import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  DeliveryResult,
  ModelProviderAdapter,
  OutboundAction,
} from "../test-support/harness/contracts.ts";
import {
  recordSessionLifecycle,
  recordSystemEvent,
} from "../test-support/harness/durable-session-transcript.ts";
import { SessionBindingStore } from "../test-support/harness/session-store.ts";
import type { Btcc } from "../agent/btcc/index.ts";
import { GatewayRouter } from "../gateways/core/router.ts";
import { createGatewayServer } from "../gateways/core/server.ts";
import { generateSessionTitleWithProvider } from "../agent/output/session-title.ts";
import { diagnosticDetails, safeRuntimeFailure } from "../integrations/providers/provider-errors.ts";
import { DeliveryGuard } from "../interfaces/transport/delivery-guard.ts";
import { createAppTransportAdapter } from "../interfaces/transport/app/adapter.ts";
import { NativeInboundQueue } from "../gateways/core/inbound-queue.ts";
import {
  resolveTelegramGatewayRuntimeConfig,
} from "../operations/gateway/registry.ts";
import {
  createProductionBtccComposition,
  type BtccComposition,
} from "../agent/composition/index.ts";
import { AppBtccStopConsumer } from "../gateways/app/application/btcc-stop-consumer.ts";
import {
  BtccInboundDispatcher,
  createBtccGatewayHandlers,
} from "../interfaces/gateway/btcc/index.ts";
import {
  appTurnEventAction,
  appTurnStateDbPath,
  bindButlerSession,
  createNativeButlerProgressPublisher,
  createNativeButlerDefaultProvider,
  persistButlerSessionPointer,
  readButlerConfig,
  requireModelRef,
  resolveButlerData,
  resolveButlerHome,
  resolveButlerSession,
  sendStartupNotification,
  startupMessage,
  statusText,
  waitForShutdown,
  writeStartupGraceMarker,
} from "../interfaces/gateway/native-butler/index.ts";
import {
  clearAppForegroundExecutorReadiness,
  publishAppForegroundExecutorReadiness,
} from "../operations/service/app-foreground-readiness.ts";
import { ensureTranscriptActivityAggregate } from "../operations/metrics/transcript-activity-index.ts";

export interface NativeButlerMainOptions {
  butlerHome?: string;
  butlerData?: string;
  btcc?: Btcc;
  btccHost?: BtccComposition["host"];
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
  shutdownReason: "signal" | "flag" | "runtime-replacement" | "bootstrap-only";
}

export { appTurnEventAction, createNativeButlerDefaultProvider };

export async function runNativeButlerMain(
  input: NativeButlerMainOptions = {},
): Promise<NativeButlerMainResult> {
  const butlerHome = resolveButlerHome(input.butlerHome);
  const butlerData = resolveButlerData(input.butlerData);
  // Reconstruct the bounded transcript activity aggregate before serving
  // status requests. This is a cold/startup path; request handlers only read
  // the resulting single checkpoint and never enumerate transcript history.
  try {
    ensureTranscriptActivityAggregate({ butlerData });
  } catch {
    // A diagnostic aggregate must not prevent the primary Agent from starting.
  }
  const config = readButlerConfig(butlerData);
  const telegramGateway = resolveTelegramGatewayRuntimeConfig({
    butlerData,
    compatibilityConfig: config as Record<string, any>,
  });
  const appMessageDbPath = appTurnStateDbPath(butlerData);
  const provider = input.provider ?? createNativeButlerDefaultProvider(config);
  const store = new SessionBindingStore(join(butlerData, "runtime", "session-store.sqlite"));
  let btcc: Btcc | undefined = input.btcc;
  let btccHost: BtccComposition["host"] | undefined = input.btccHost;
  let btccReady: Promise<void> | undefined;
  const shutdownFlagPath = join(butlerData, "locks", "butler-shutdown");
  const pollMs = input.shutdownPollMs ?? 500;

  let sessionId: string | null = null;
  let stopTelegramPolling = false;
  let runtimeReplacementRequested = false;
  let telegramPolling: Promise<void> | undefined;
  let stopConsumer: AppBtccStopConsumer | undefined;
  const inboundDispatcher = new BtccInboundDispatcher();
  const inboundQueue = new NativeInboundQueue(butlerData);
  const serviceShouldStop = () =>
    stopTelegramPolling || runtimeReplacementRequested ||
    input.shutdownSignal?.aborted || existsSync(shutdownFlagPath);
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
    if (!btcc) {
      const composition = createProductionBtccComposition({
        butlerHome,
        butlerData,
        appMessageDbPath,
        ownerId: `native-butler:${process.pid}`,
        sessionBindings: store,
      });
      btcc = composition.btcc;
      btccHost = composition.host;
      btccReady = composition.ready;
    }
    if (!btcc) throw new Error("BTCC facade was not created");
    await btccReady;

    const router = new GatewayRouter({ store });
    const telegramAdapter = telegramGateway.enabled
      ? (await import("../interfaces/transport/telegram/adapter.ts"))
        .createTelegramTransportAdapter({
          butlerHome,
          sendTelegram: input.sendTelegram,
        })
      : null;
    const appAdapter = createAppTransportAdapter();
    const deliveryGuard = new DeliveryGuard({
      adapters: telegramAdapter ? [telegramAdapter, appAdapter] : [appAdapter],
      butlerData,
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
    const progressPublisher = createNativeButlerProgressPublisher({
      deliver: deliverThroughEnabledGate,
    });
    if (btccHost) {
      stopConsumer = new AppBtccStopConsumer(appMessageDbPath, btcc, btccHost.progress);
      await stopConsumer.reconcile();
      await btccHost.progress.reconcile(progressPublisher);
    }
    const recovered = inboundQueue.recoverRuntimeInterruptions(() => true);
    if (recovered.requeued > 0) {
      process.stdout.write(
        `[inbound-queue] recovered-runtime-interruptions=${recovered.requeued}\n`,
      );
    }
    const server = createGatewayServer({
      router,
      handlers: createBtccGatewayHandlers({
        btcc,
        generateSessionTitle: ({ route, envelope }) => {
          const activeBinding = store.getBySessionId(route.sessionId);
          if (!activeBinding) return Promise.resolve(null);
          return generateSessionTitleWithProvider(provider, {
            text: envelope.message.text ?? "",
            model: requireModelRef(activeBinding.modelRef),
            signal: envelope.signal,
          });
        },
      }),
      butlerData,
    });
    if (telegramAdapter) {
      const [{ createTelegramLiveGateway }, { runTelegramPolling }] =
        await Promise.all([
          import("../interfaces/transport/telegram/live-gateway.ts"),
          import("../interfaces/transport/telegram/polling-runner.ts"),
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
        shouldReplaceProcess: () => runtimeReplacementRequested,
        onPoll: async () => {
          await stopConsumer?.reconcile();
          await btccHost?.progress.reconcile(progressPublisher);
          const summary = inboundDispatcher.poll({
            queue: inboundQueue,
            server,
            store,
            deliveryGuard,
            deliverAction: deliverThroughEnabledGate,
            limit: 5,
            maxConcurrentSessions: 5,
            onOutcome: (outcome) => {
              if (outcome.interrupted > 0) runtimeReplacementRequested = true;
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
          source: "application/native-butler.ts",
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
          source: "application/native-butler.ts",
          code: safeFailure.code,
        },
        timestamp,
      });
    }
    throw error;
  } finally {
    clearAppForegroundExecutorReadiness(butlerData);
    stopTelegramPolling = true;
    stopConsumer?.close();
    await btccHost?.close();
    store.close();
  }
}
