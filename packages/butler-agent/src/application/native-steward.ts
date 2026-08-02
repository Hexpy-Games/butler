import { homedir } from "os";
import { join } from "path";
import type {
  DeliveryResult,
  OutboundAction,
  InboundEnvelope,
  ModelProviderAdapter,
  SessionLifecycleState,
  StoredSessionBinding,
} from "../test-support/harness/contracts.ts";
import type { Btcc } from "../agent/btcc/index.ts";
import { getStewardSessionPointer, registerRuntimeSession } from "../test-support/harness/session-runtime.ts";
import { SessionBindingStore } from "../test-support/harness/session-store.ts";
import {
  createProductionBtccComposition,
  type BtccComposition,
} from "../agent/composition/index.ts";
import {
  createBtccGatewayHandlers,
} from "../interfaces/gateway/btcc/index.ts";
import { DeliveryGuard } from "../interfaces/transport/delivery-guard.ts";
import { createTelegramTransportAdapter } from "../interfaces/transport/telegram/adapter.ts";
import { createNativeButlerProgressPublisher } from "../interfaces/gateway/native-butler/index.ts";
import { resolveAppGatewayRuntimeConfig } from "../operations/gateway/registry.ts";

export interface NativeStewardTelegramTurnInput {
  projectName: string;
  workspacePath: string;
  message: string;
  chatId: string;
  threadId?: string;
  messageId?: string;
  senderId?: string;
  senderDisplayName?: string;
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
}

export interface NativeStewardTelegramTurnResult {
  sessionId: string;
  text: string;
  delivery: DeliveryResult;
}

function getButlerHome(explicit?: string): string {
  return explicit || process.env.BUTLER_HOME || process.cwd();
}

function getButlerData(_butlerHome: string, explicit?: string): string {
  return explicit || process.env.BUTLER_DATA || join(homedir(), ".butler");
}

function defaultProvider(): ModelProviderAdapter {
  return {
    id: "openai",
    capabilities: {
      supportsStreaming: false,
      supportsToolCalls: true,
      supportsImages: false,
      supportsAudio: false,
      supportsServerThreads: false,
      supportsReasoningConfig: true,
      supportsPromptCaching: true,
      supportsSameTurnToolSchemaPromotion: true,
    },
    async invoke() {
      throw new Error("Native steward application does not call provider.invoke directly");
    },
  };
}

function makeSessionId(projectName: string): string {
  return `steward/${projectName.replace(/[^A-Za-z0-9._-]/g, "-")}`;
}

function resolveSessionId(store: SessionBindingStore, butlerData: string, projectName: string): string {
  const pointer = getStewardSessionPointer(butlerData, projectName);
  if (pointer) return pointer;

  const existing = store
    .listSessions({ lifecycleState: ["active", "closing"] satisfies SessionLifecycleState[] })
    .find((session) => session.role === "steward" && session.projectId === projectName);
  if (existing) return existing.sessionId;

  return makeSessionId(projectName);
}

function ensureStewardSession(input: {
  store: SessionBindingStore;
  sessionId: string;
  projectName: string;
  workspacePath: string;
  runtimeAdapterId: string;
  provider: ModelProviderAdapter;
  butlerHome: string;
  butlerData: string;
}): StoredSessionBinding {
  const existing = input.store.getBySessionId(input.sessionId);
  if (!existing || existing.lifecycleState === "closed" || existing.lifecycleState === "crashed") {
    return registerRuntimeSession({
      sessionId: input.sessionId,
      role: "steward",
      workspacePath: input.workspacePath,
      runtimeAdapterId: input.runtimeAdapterId,
      modelProviderId: input.provider.id,
      butlerHome: input.butlerHome,
      butlerData: input.butlerData,
      source: "native-steward-application",
    });
  }

  const updated = input.store.upsert({
    sessionId: existing.sessionId,
    role: existing.role,
    projectId: existing.projectId,
    workspacePath: existing.workspacePath,
    runtimeAdapterId: input.runtimeAdapterId,
    modelProviderId: providerIdFromModelRef(
      existing.modelRef,
      input.provider.id,
    ),
    modelRef: existing.modelRef,
    runtimeSessionRef: existing.runtimeSessionRef,
    providerThreadRef: existing.providerThreadRef,
    transportBindings: existing.transportBindings,
    metadata: existing.metadata,
    lifecycleState: "active",
    createdAt: existing.createdAt,
  });

  return updated;
}

function providerIdFromModelRef(
  modelRef: string | undefined,
  fallback: string,
): string {
  return modelRef?.split("/", 1)[0]?.trim() || fallback;
}

function buildEnvelope(input: NativeStewardTelegramTurnInput): InboundEnvelope {
  const timestamp = new Date().toISOString();
  return {
    eventId: `telegram:${input.chatId}:${input.threadId ?? "main"}:${input.messageId ?? timestamp}`,
    transport: "telegram",
    accountId: "default",
    peer: input.threadId
      ? {
          kind: "thread",
          id: input.threadId,
          parentId: input.chatId,
        }
      : {
          kind: "group",
          id: input.chatId,
        },
    sender: {
      id: input.senderId?.trim() || "telegram-user",
      displayName: input.senderDisplayName?.trim() || undefined,
    },
    message: {
      id: input.messageId?.trim() || `msg-${timestamp}`,
      text: input.message,
      timestamp,
    },
    routingHints: {
      projectId: input.projectName,
      stewardId: makeSessionId(input.projectName),
    },
  };
}

export async function handleNativeStewardTelegramTurn(
  input: NativeStewardTelegramTurnInput,
): Promise<NativeStewardTelegramTurnResult> {
  const butlerHome = getButlerHome(input.butlerHome);
  const butlerData = getButlerData(butlerHome, input.butlerData);
  const provider = input.provider ?? defaultProvider();
  const appGateway = resolveAppGatewayRuntimeConfig({ butlerData });
  const appMessageDbPath = appGateway.dbPath ?? join(
    butlerData,
    "app-server",
    "butler-client.sqlite",
  );
  const store = new SessionBindingStore(join(butlerData, "runtime", "session-store.sqlite"));
  let btcc: Btcc | undefined = input.btcc;
  let btccHost: BtccComposition["host"] | undefined = input.btccHost;
  let btccReady: Promise<void> | undefined;
  const deliveryGuard = new DeliveryGuard({
    adapters: [
      createTelegramTransportAdapter({
        butlerHome,
        sendTelegram: input.sendTelegram,
      }),
    ],
  });
  const progressPublisher = createNativeButlerProgressPublisher({
    deliver: (sessionId, action, metadata) => deliveryGuard.deliver(sessionId, action, metadata),
  });

  try {
    const sessionId = resolveSessionId(store, butlerData, input.projectName);
    ensureStewardSession({
      store,
      sessionId,
      projectName: input.projectName,
      workspacePath: input.workspacePath,
      runtimeAdapterId: "btcc-turn-runtime",
      provider,
      butlerHome,
      butlerData,
    });

    if (!btcc) {
      const composition = createProductionBtccComposition({
        butlerHome,
        butlerData,
        appMessageDbPath,
        ownerId: `native-steward:${process.pid}`,
        sessionBindings: store,
      });
      btcc = composition.btcc;
      btccHost = composition.host;
      btccReady = composition.ready;
    }
    if (!btcc) throw new Error("BTCC facade was not created");
    await btccReady;

    const envelope = buildEnvelope(input);
    const route = {
      sessionId,
      role: "steward",
      reason: "transport-binding",
      projectId: input.projectName,
      workspacePath: input.workspacePath,
    } as const;
    const handler = createBtccGatewayHandlers({ btcc }).steward;
    if (!handler) throw new Error("BTCC steward handler is unavailable");
    const result = await handler({ envelope, route });
    const text = typeof result.metadata?.text === "string"
      ? result.metadata.text
      : "";

    const action: OutboundAction = {
      actionId: `telegram-out:${sessionId}:${input.chatId}:${input.threadId ?? "main"}:${input.messageId ?? Date.now()}`,
      transport: "telegram",
      accountId: "default",
      peer: input.threadId
        ? {
            kind: "thread",
            id: input.chatId,
            threadId: input.threadId,
          }
        : {
            kind: "group",
            id: input.chatId,
          },
      message: {
        text,
      },
      metadata: {
        source: "application/native-steward.ts",
      },
    };
    const [deliveryResult] = await deliveryGuard.deliverAll(sessionId, [action], {
      source: "application/native-steward.ts",
    });
    const delivery: DeliveryResult = {
      ok: deliveryResult.ok,
      error: deliveryResult.error,
      raw: deliveryResult.raw,
      transportMessageId: deliveryResult.transportMessageId,
    };

    return {
      sessionId,
      text,
      delivery,
    };
  } finally {
    try {
      await btccHost?.progress.reconcile(progressPublisher);
    } finally {
      await btccHost?.close();
    }
    store.close();
  }
}
