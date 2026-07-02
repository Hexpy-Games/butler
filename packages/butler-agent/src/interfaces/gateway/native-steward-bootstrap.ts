import { homedir } from "os";
import { join } from "path";
import type {
  AgentRuntimeAdapter,
  DeliveryResult,
  OutboundAction,
  InboundEnvelope,
  ModelProviderAdapter,
  SessionLifecycleState,
  StoredSessionBinding,
} from "../../test-support/harness/contracts.ts";
import { getStewardSessionPointer, registerRuntimeSession } from "../../test-support/harness/session-runtime.ts";
import { SessionBindingStore } from "../../test-support/harness/session-store.ts";
import { PolicyEngine, type PolicyApprovalMode, type PolicyToolDefinition } from "../../agent/policy/policy-engine.ts";
import { PromptAssembler } from "../../agent/prompt/prompt-assembler.ts";
import { AgentConversationStore } from "../../agent/conversation/store.ts";
import { SessionLifecycleService } from "./session-lifecycle.ts";
import { NativeToolLoopRuntime } from "../../agent/turn/native-tool-loop.ts";
import { DeliveryGuard } from "../transport/delivery-guard.ts";
import { createTelegramTransportAdapter } from "../transport/telegram/adapter.ts";

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
  runtime?: AgentRuntimeAdapter;
  provider?: ModelProviderAdapter;
  sendTelegram?: (input: {
    chatId: string;
    text: string;
    threadId?: string;
  }) => Promise<DeliveryResult>;
  approvalMode?: PolicyApprovalMode;
}

export interface NativeStewardTelegramTurnResult {
  sessionId: string;
  text: string;
  delivery: DeliveryResult;
}

const STEWARD_NATIVE_TOOLS: PolicyToolDefinition[] = [
  {
    name: "reply",
    description: "Reply to the principal.",
    inputSchema: {},
    roles: ["butler", "steward"],
  },
  {
    name: "list_tasks",
    description: "List worker tasks.",
    inputSchema: {},
    roles: ["butler", "steward"],
  },
  {
    name: "get_task_result",
    description: "Get a worker task result.",
    inputSchema: {},
    roles: ["butler", "steward"],
  },
  {
    name: "project_memory_search",
    description: "Search project-local memory.",
    inputSchema: {},
    roles: ["steward"],
    requiresProject: true,
  },
];

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
      throw new Error("Native steward bootstrap does not call provider.invoke directly");
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
  runtime: AgentRuntimeAdapter;
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
      runtimeAdapterId: input.runtime.id,
      modelProviderId: input.provider.id,
      butlerHome: input.butlerHome,
      butlerData: input.butlerData,
      source: "native-steward-bootstrap",
    });
  }

  const updated = input.store.upsert({
    sessionId: existing.sessionId,
    role: existing.role,
    projectId: existing.projectId,
    workspacePath: existing.workspacePath,
    runtimeAdapterId: input.runtime.id,
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
  const runtime = input.runtime ?? new NativeToolLoopRuntime();
  const provider = input.provider ?? defaultProvider();
  const store = new SessionBindingStore(join(butlerData, "runtime", "session-store.sqlite"));
  const conversationWriter = new AgentConversationStore({ butlerData });

  try {
    const sessionId = resolveSessionId(store, butlerData, input.projectName);
    ensureStewardSession({
      store,
      sessionId,
      projectName: input.projectName,
      workspacePath: input.workspacePath,
      runtime,
      provider,
      butlerHome,
      butlerData,
    });

    const lifecycle = new SessionLifecycleService({
      store,
      runtime,
      provider,
      promptAssembler: new PromptAssembler({
        butlerHome,
        butlerData,
      }),
      policyEngine: new PolicyEngine(),
      tools: STEWARD_NATIVE_TOOLS,
      approvalMode: input.approvalMode ?? "default",
      conversationWriter,
      conversationMetricsButlerData: butlerData,
    });

    const actor = await lifecycle.getOrCreate(sessionId, "steward");
    const result = await actor.handleInbound(buildEnvelope(input), {
      sessionId,
      role: "steward",
      reason: "transport-binding",
      projectId: input.projectName,
      workspacePath: input.workspacePath,
    });

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
        text: result.text,
      },
      metadata: {
        source: "gateway/native-steward-bootstrap.ts",
      },
    };
    const guard = new DeliveryGuard({
      adapters: [
        createTelegramTransportAdapter({
          butlerHome,
          sendTelegram: input.sendTelegram,
        }),
      ],
    });
    const [deliveryResult] = await guard.deliverAll(sessionId, [action], {
      source: "gateway/native-steward-bootstrap.ts",
    });
    const delivery: DeliveryResult = {
      ok: deliveryResult.ok,
      error: deliveryResult.error,
      raw: deliveryResult.raw,
      transportMessageId: deliveryResult.transportMessageId,
    };

    return {
      sessionId,
      text: result.text,
      delivery,
    };
  } finally {
    conversationWriter.close();
    store.close();
  }
}
