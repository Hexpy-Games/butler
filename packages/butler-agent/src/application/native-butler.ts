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
  validateAgentBtccStorageForReadiness,
} from "../agent/adapters/index.ts";
import {
  createProductionBtccComposition,
  type BtccComposition,
} from "../agent/composition/index.ts";
import {
  BtccInboundDispatcher,
  createBtccGatewayHandlers,
} from "../interfaces/gateway/btcc/index.ts";
import {
  appTurnEventAction,
  bindButlerSession,
  createNativeButlerProgressPublisher,
  createNativeButlerDefaultProvider,
  persistButlerSessionPointer,
  readButlerConfig,
  requireModelRef,
  resolveButlerData,
  resolveButlerHome,
  resolveButlerSession,
  startupMessage,
  waitForShutdown,
  writeStartupGraceMarker,
} from "../interfaces/gateway/native-butler/index.ts";
import {
  clearAppForegroundExecutorReadiness,
  publishAppForegroundExecutorReadiness,
} from "../operations/service/app-foreground-readiness.ts";

export interface NativeButlerMainOptions {
  butlerHome?: string;
  butlerData?: string;
  btcc?: Btcc;
  btccHost?: BtccComposition["host"];
  provider?: ModelProviderAdapter;
  shutdownSignal?: AbortSignal;
  shutdownPollMs?: number;
  waitForShutdown?: boolean;
}

export interface NativeButlerMainResult {
  sessionId: string;
  startupMessage: string;
  shutdownReason: "signal" | "flag" | "runtime-replacement" | "bootstrap-only";
}

export { appTurnEventAction, createNativeButlerDefaultProvider };

export async function runNativeButlerMain(
  input: NativeButlerMainOptions = {},
): Promise<NativeButlerMainResult> {
  const butlerHome = resolveButlerHome(input.butlerHome);
  const butlerData = resolveButlerData(input.butlerData);
  const config = readButlerConfig(butlerData);
  const provider = input.provider ?? createNativeButlerDefaultProvider(config);
  const store = new SessionBindingStore(join(butlerData, "runtime", "session-store.sqlite"));
  let btcc: Btcc | undefined = input.btcc;
  let btccHost: BtccComposition["host"] | undefined = input.btccHost;
  let btccReady: Promise<void> | undefined;
  const shutdownFlagPath = join(butlerData, "locks", "butler-shutdown");
  const pollMs = input.shutdownPollMs ?? 500;

  let sessionId: string | null = null;
  let runtimeReplacementRequested = false;
  const inboundDispatcher = new BtccInboundDispatcher();
  const inboundQueue = new NativeInboundQueue(butlerData);
  try {
    clearAppForegroundExecutorReadiness(butlerData);
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
      validateAgentBtccStorageForReadiness({ butlerData });
      const composition = createProductionBtccComposition({
        butlerHome,
        butlerData,
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
    const appAdapter = createAppTransportAdapter();
    const deliveryGuard = new DeliveryGuard({
      adapters: [appAdapter],
      butlerData,
    });
    const deliverThroughEnabledGate = async (
      activeSessionId: string,
      action: OutboundAction,
      metadata: Record<string, unknown>,
    ): Promise<DeliveryResult> => {
      return await deliveryGuard.deliver(activeSessionId, action, metadata);
    };
    const progressPublisher = createNativeButlerProgressPublisher({
      deliver: deliverThroughEnabledGate,
    });
    if (btccHost) await btccHost.progress.reconcile(progressPublisher);
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
    writeStartupGraceMarker(butlerData);
    const startupText = startupMessage(binding.modelRef);
    publishAppForegroundExecutorReadiness(butlerData);

    let shutdownReason: NativeButlerMainResult["shutdownReason"] = "bootstrap-only";
    if (input.waitForShutdown !== false) {
      shutdownReason = await waitForShutdown({
        shutdownFlagPath,
        signal: input.shutdownSignal,
        pollMs,
        shouldReplaceProcess: () => runtimeReplacementRequested,
        onPoll: async () => {
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
    }

    return {
      sessionId: binding.sessionId,
      startupMessage: startupText,
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
    await btccHost?.close();
    store.close();
  }
}
