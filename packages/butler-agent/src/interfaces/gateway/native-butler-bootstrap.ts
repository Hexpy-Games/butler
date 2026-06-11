import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import type {
  AgentRuntimeAdapter,
  DeliveryResult,
  InboundEnvelope,
  ModelProviderAdapter,
  OutboundAction,
  SessionLifecycleState,
  StoredSessionBinding,
} from "../../test-support/harness/contracts.ts";
import { recordSessionLifecycle, recordSystemEvent } from "../../test-support/harness/durable-session-transcript.ts";
import { registerRuntimeSession } from "../../test-support/harness/session-runtime.ts";
import { SessionBindingStore } from "../../test-support/harness/session-store.ts";
import { GatewayRouter } from "../../gateways/core/router.ts";
import { createGatewayServer } from "../../gateways/core/server.ts";
import { PolicyEngine, type PolicyApprovalMode } from "../../agent/policy/policy-engine.ts";
import { PromptAssembler } from "../../agent/prompt/prompt-assembler.ts";
import { createLifecycleGatewayHandlers, SessionLifecycleService } from "./session-lifecycle.ts";
import { generateSessionTitleWithProvider } from "../../agent/output/session-title.ts";
import { NativeToolLoopRuntime } from "../../agent/turn/native-tool-loop.ts";
import { diagnosticDetails, safeRuntimeFailure } from "../../integrations/providers/provider-errors.ts";
import { DeliveryGuard } from "../transport/delivery-guard.ts";
import { createAppTransportAdapter } from "../transport/app/adapter.ts";
import { createTelegramTransportAdapter } from "../transport/telegram/adapter.ts";
import { createTelegramLiveGateway } from "../transport/telegram/live-gateway.ts";
import { runTelegramPolling } from "../transport/telegram/polling-runner.ts";
import { runWorkerResultMonitor } from "./worker-result-monitor.ts";
import { runPromptText } from "../../integrations/providers/provider.ts";
import { plannedInternalGoal, PlannedTaskStore } from "../../agent/work/planned-task.ts";
import type { TaskRecord } from "../../agent/work/task-store.ts";
import { NativeInboundQueue, type ClaimedInboundEvent } from "../../gateways/core/inbound-queue.ts";
import {
  resolveAppGatewayRuntimeConfig,
  resolveTelegramGatewayRuntimeConfig,
} from "../../operations/gateway/registry.ts";
import { QueuedInboundDispatcher } from "./queued-inbound.ts";

interface ButlerConfig {
  system?: {
    runtime?: string;
    butlerModel?: string;
    defaultModel?: string;
  };
  telegram?: {
    groupId?: string;
  };
}

export interface NativeButlerMainOptions {
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
  shutdownSignal?: AbortSignal;
  shutdownPollMs?: number;
  workerResultPollMs?: number;
  enableTelegramPolling?: boolean;
  waitForShutdown?: boolean;
}

export interface NativeButlerMainResult {
  sessionId: string;
  startupMessage: string;
  startupDelivery?: DeliveryResult;
  shutdownReason: "signal" | "flag" | "bootstrap-only";
}

const DEFAULT_BUTLER_SESSION_ID = "butler/main";

function getButlerHome(explicit?: string): string {
  return explicit || process.env.BUTLER_HOME || process.cwd();
}

function getButlerData(_butlerHome: string, explicit?: string): string {
  return explicit || process.env.BUTLER_DATA || join(homedir(), ".butler");
}

function readButlerConfig(butlerData: string): ButlerConfig {
  const path = join(butlerData, "butler.config.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ButlerConfig;
  } catch {
    return {};
  }
}

function defaultProvider(config: ButlerConfig = {}): ModelProviderAdapter {
  const configuredModel = config.system?.butlerModel || config.system?.defaultModel || "";
  const providerId = configuredModel.includes("/")
    ? configuredModel.split("/", 1)[0] || "openai"
    : "openai";
  return {
    id: providerId,
    capabilities: {
      supportsStreaming: false,
      supportsToolCalls: false,
      supportsImages: false,
      supportsAudio: false,
      supportsServerThreads: false,
      supportsReasoningConfig: true,
      supportsPromptCaching: true,
    },
    async invoke(input) {
      const prompt = input.messages
        .map((message) => `${message.role}: ${message.content}`)
        .join("\n\n");
      const text = await runPromptText({
        prompt,
        model: input.model,
        instructions: input.systemPrompt,
        cacheScope: "native-butler-title-provider",
      });
      return { text };
    },
  };
}

function trimForCompletionEvent(value: string | null | undefined, limit: number): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}\n...[truncated]` : trimmed;
}

function buildWorkerCompletionEnvelope(input: {
  accountId: string;
  peerId: string;
  task: TaskRecord;
}): InboundEnvelope {
  const result = trimForCompletionEvent(input.task.observedResult, 6_000) ||
    "No result.md was produced and no worker log summary was available.";
  const origin = trimForCompletionEvent(input.task.origin?.task_summary ?? input.task.request, 1_200);
  const text = [
    "System event: a background worker task completed.",
    "This is not a user request to start new work.",
    "Read the worker result and produce a concise user-facing completion report in the active Butler persona and response language.",
    "Do not dump raw internal fields. Do not include the full request unless it is necessary. Mention clear next steps when useful.",
    "",
    `Task ID: ${input.task.taskId}`,
    `Status: ${input.task.status}`,
    `Project: ${input.task.project ?? input.task.origin?.project ?? "unknown"}`,
    "",
    "Original request summary:",
    origin || "unknown",
    "",
    "Worker result:",
    result,
  ].join("\n");

  return {
    eventId: `system:worker-complete:${input.task.taskId}:${Date.now()}`,
    transport: "system",
    accountId: input.accountId,
    peer: {
      kind: "dm",
      id: input.peerId,
    },
    sender: {
      id: "butler-worker-monitor",
      displayName: "Butler Worker Monitor",
    },
    message: {
      id: `worker-complete:${input.task.taskId}`,
      text,
      timestamp: new Date().toISOString(),
    },
  };
}

function buildPlannedReviewEnvelope(input: {
  accountId: string;
  peerId: string;
  butlerData: string;
  plannedTaskId: string;
  workerTaskId: string;
  attempt: number;
  reviewEventId: string;
  status: string;
}): InboundEnvelope {
  const planned = new PlannedTaskStore(input.butlerData).read(input.plannedTaskId);
  const plan = planned?.plan;
  const result = trimForCompletionEvent(planned?.latestResult, 6_000) ||
    "No linked worker result was available.";
  const criteria = plan?.acceptance_criteria.map((criterion, index) => `- AC${index + 1}: ${criterion}`).join("\n") ||
    "- No criteria found; mark review inconclusive.";
  const text = [
    "System event: a planned background worker attempt completed.",
    "This is not a user request and must not be reported as raw worker success.",
    "Review the result against every acceptance criterion and the internal GOAL, then call `review_planned_task` before any public completion report.",
    "When calling `review_planned_task`, include `criterion_index` for each AC number so coverage is structural, not text-match dependent.",
    "Also include `goal_review` with PASS/FAIL/INCONCLUSIVE and concise evidence for whether the GOAL is complete.",
    "If evidence is missing, use INCONCLUSIVE or FAIL with a repair recommendation.",
    "",
    `Planned task ID: ${input.plannedTaskId}`,
    `Attempt: ${input.attempt}`,
    `Worker task ID: ${input.workerTaskId}`,
    `Review event ID: ${input.reviewEventId}`,
    `Status: ${input.status || planned?.status || "unknown"}`,
    `GOAL: ${plan ? plannedInternalGoal(plan) : "unknown"}`,
    `User-facing objective: ${plan?.goal ?? "unknown"}`,
    `Project: ${plan?.project ?? "unknown"}`,
    "",
    "Acceptance criteria:",
    criteria,
    "",
    "Worker result:",
    result,
  ].join("\n");

  return {
    eventId: `system:planned-review:${input.plannedTaskId}:attempt-${input.attempt}:${input.reviewEventId}`,
    transport: "system",
    accountId: input.accountId,
    peer: {
      kind: "dm",
      id: input.peerId,
    },
    sender: {
      id: "butler-worker-monitor",
      displayName: "Butler Worker Monitor",
    },
    message: {
      id: `planned-review:${input.plannedTaskId}`,
      text,
      timestamp: new Date().toISOString(),
    },
  };
}

function sessionPointerPath(butlerData: string): string {
  return join(butlerData, "config", "session-id.txt");
}

function writeButlerSessionPointer(butlerData: string, sessionId: string): void {
  const path = sessionPointerPath(butlerData);
  mkdirSync(join(butlerData, "config"), { recursive: true });
  writeFileSync(path, `${sessionId}\n`, "utf8");
}

function readButlerSessionPointer(butlerData: string): string | null {
  const path = sessionPointerPath(butlerData);
  if (!existsSync(path)) return null;
  try {
    const value = readFileSync(path, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function resolveSessionId(store: SessionBindingStore, butlerData: string): string {
  const pointer = readButlerSessionPointer(butlerData);
  if (pointer) return pointer;

  const existing = store
    .listSessions({ lifecycleState: ["active", "closing"] satisfies SessionLifecycleState[] })
    .filter((session) => session.role === "butler")
    .sort((a, b) => {
      const left = a.lastActiveAt ?? a.updatedAt;
      const right = b.lastActiveAt ?? b.updatedAt;
      return right.localeCompare(left);
    })[0];
  if (existing) return existing.sessionId;

  return DEFAULT_BUTLER_SESSION_ID;
}

function ensureButlerSession(input: {
  store: SessionBindingStore;
  sessionId: string;
  butlerHome: string;
  butlerData: string;
  runtime: AgentRuntimeAdapter;
  provider: ModelProviderAdapter;
}): StoredSessionBinding {
  const existing = input.store.getBySessionId(input.sessionId);
  if (!existing || existing.lifecycleState === "closed" || existing.lifecycleState === "crashed") {
    return registerRuntimeSession({
      sessionId: input.sessionId,
      role: "butler",
      workspacePath: input.butlerHome,
      runtimeAdapterId: input.runtime.id,
      modelProviderId: input.provider.id,
      butlerHome: input.butlerHome,
      butlerData: input.butlerData,
      source: "native-butler-bootstrap",
    });
  }

  return input.store.upsert({
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
}

function providerIdFromModelRef(
  modelRef: string | undefined,
  fallback: string,
): string {
  return modelRef?.split("/", 1)[0]?.trim() || fallback;
}

function countRunningTasks(butlerData: string): number {
  const tasksDir = join(butlerData, "tasks");
  if (!existsSync(tasksDir)) return 0;

  let count = 0;
  for (const taskId of readdirSync(tasksDir)) {
    const taskDir = join(tasksDir, taskId);
    if (!statSync(taskDir, { throwIfNoEntry: false })?.isDirectory()) continue;
    const statusPath = join(taskDir, "status");
    if (!existsSync(statusPath)) continue;
    const status = readFileSync(statusPath, "utf8").trim();
    if (status === "RUNNING") count += 1;
  }
  return count;
}

function buildStartupMessage(modelRef: string, runningTaskCount: number): string {
  const model = modelRef.includes("/") ? modelRef.split("/", 2)[1] : modelRef;
  let message = `🔄 Butler started (model: ${model})`;
  if (runningTaskCount > 0) {
    message += ` — ${runningTaskCount} incomplete task(s) found`;
  }
  return message;
}

function buildStatusText(input: {
  sessionId: string;
  modelRef: string;
  butlerData: string;
}): string {
  return [
    "Butler status: online",
    `session: ${input.sessionId}`,
    `model: ${input.modelRef}`,
    `data: ${input.butlerData}`,
  ].join("\n");
}

function appTurnStateDbPath(butlerData: string): string {
  const config = resolveAppGatewayRuntimeConfig({ butlerData });
  return config.dbPath ?? join(butlerData, "app-server", "butler-client.sqlite");
}

function shouldHandleAppInboundTurn(butlerData: string): (item: ClaimedInboundEvent) => boolean {
  const dbPath = appTurnStateDbPath(butlerData);
  return (item) => {
    const turnId = item.envelope.routingHints?.turnId?.trim();
    if (!turnId || !existsSync(dbPath)) return true;
    let db: Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      const row = db
        .query<{ state: string }, [string]>("SELECT state FROM turns WHERE id = ?")
        .get(turnId);
      return !row || !["cancelled", "delivered", "failed"].includes(row.state);
    } catch {
      return true;
    } finally {
      db?.close();
    }
  };
}

function writeStartupGraceMarker(butlerData: string): void {
  mkdirSync(join(butlerData, "state"), { recursive: true });
  writeFileSync(join(butlerData, "state", "startup-grace-until"), `${Date.now() / 1000 + 45}\n`, "utf8");
}

async function sendStartupNotification(input: {
  butlerHome: string;
  chatId?: string;
  sessionId: string;
  startupMessage: string;
  sendTelegram?: NativeButlerMainOptions["sendTelegram"];
}): Promise<DeliveryResult | undefined> {
  const chatId = input.chatId?.trim();
  if (!chatId) return undefined;

  const action: OutboundAction = {
    actionId: `telegram-out:${input.sessionId}:startup`,
    transport: "telegram",
    accountId: "default",
    peer: {
      kind: "group",
      id: chatId,
    },
    message: {
      text: input.startupMessage,
    },
    metadata: {
      source: "gateway/native-butler-bootstrap.ts",
      type: "startup-notification",
    },
  };
  const guard = new DeliveryGuard({
    adapters: [
      createTelegramTransportAdapter({
        butlerHome: input.butlerHome,
        sendTelegram: input.sendTelegram,
      }),
    ],
  });
  const result = await guard.deliver(input.sessionId, action, {
    source: "gateway/native-butler-bootstrap.ts",
    type: "startup-notification",
  });
  return {
    ok: result.ok,
    error: result.error,
    raw: result.raw,
    transportMessageId: result.transportMessageId,
  };
}

async function waitForShutdown(input: {
  shutdownFlagPath: string;
  signal?: AbortSignal;
  pollMs: number;
  onPoll?: () => Promise<void>;
}): Promise<"signal" | "flag"> {
  while (true) {
    if (input.signal?.aborted) return "signal";
    if (existsSync(input.shutdownFlagPath)) return "flag";
    await input.onPoll?.();
    await new Promise((resolve) => setTimeout(resolve, input.pollMs));
  }
}

export async function runNativeButlerMain(
  input: NativeButlerMainOptions = {},
): Promise<NativeButlerMainResult> {
  const butlerHome = getButlerHome(input.butlerHome);
  const butlerData = getButlerData(butlerHome, input.butlerData);
  const config = readButlerConfig(butlerData);
  const telegramGateway = resolveTelegramGatewayRuntimeConfig({
    butlerData,
    compatibilityConfig: config as Record<string, any>,
  });
  const runtime = input.runtime ?? new NativeToolLoopRuntime({ butlerHome, butlerData });
  const provider = input.provider ?? defaultProvider(config);
  const store = new SessionBindingStore(join(butlerData, "runtime", "session-store.sqlite"));
  const shutdownFlagPath = join(butlerData, "locks", "butler-shutdown");
  const pollMs = input.shutdownPollMs ?? 500;

  let sessionId: string | null = null;
  let stopTelegramPolling = false;
  let telegramPolling: Promise<void> | undefined;
  let workerResultMonitor: Promise<void> | undefined;
  let appWorkerResultMonitor: Promise<void> | undefined;
  const inboundDispatcher = new QueuedInboundDispatcher();
  const serviceShouldStop = () =>
    stopTelegramPolling || input.shutdownSignal?.aborted || existsSync(shutdownFlagPath);
  const currentTelegramGateway = () =>
    resolveTelegramGatewayRuntimeConfig({
      butlerData,
      compatibilityConfig: readButlerConfig(butlerData) as Record<string, any>,
    });
  const telegramShouldStop = () => serviceShouldStop() || !currentTelegramGateway().enabled;
  const currentTelegramChatId = () => {
    const current = currentTelegramGateway();
    return current.enabled ? current.chatId ?? undefined : undefined;
  };

  try {
    sessionId = resolveSessionId(store, butlerData);
    const binding = ensureButlerSession({
      store,
      sessionId,
      butlerHome,
      butlerData,
      runtime,
      provider,
    });
    writeButlerSessionPointer(butlerData, binding.sessionId);

    const router = new GatewayRouter({ store });
    const telegramAdapter = createTelegramTransportAdapter({
      butlerHome,
      sendTelegram: input.sendTelegram,
    });
    const appAdapter = createAppTransportAdapter();
    const deliveryGuard = new DeliveryGuard({
      adapters: [telegramAdapter, appAdapter],
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
    const lifecycle = new SessionLifecycleService({
      store,
      runtime,
      provider,
      promptAssembler: new PromptAssembler({
        butlerHome,
        butlerData,
      }),
      policyEngine: new PolicyEngine(),
      sessionTitleGenerator: (titleInput) =>
        generateSessionTitleWithProvider(provider, titleInput),
      approvalMode: input.approvalMode ?? "default",
      deliverIntermediate: async ({ binding: activeBinding, action, metadata }) => {
        await deliverThroughEnabledGate(activeBinding.sessionId, action, {
          source: "gateway/native-butler-bootstrap.ts#intermediate",
          ...(metadata ?? {}),
        });
      },
    });
    await lifecycle.getOrCreate(binding.sessionId, "butler");
    const server = createGatewayServer({
      router,
      handlers: createLifecycleGatewayHandlers(lifecycle),
      butlerData,
    });
    const gateway = createTelegramLiveGateway({
      adapter: telegramAdapter,
      router,
      server,
      renderStatus: () => buildStatusText({
        sessionId: binding.sessionId,
        modelRef: binding.modelRef,
        butlerData,
      }),
    });
    await gateway.start();
    telegramPolling = input.enableTelegramPolling === false || !telegramGateway.enabled
      ? undefined
      : runTelegramPolling({
          butlerData,
          gateway,
          shouldStop: telegramShouldStop,
          log: (line) => {
            process.stdout.write(`[telegram] ${line}\n`);
          },
        });
    workerResultMonitor = telegramGateway.enabled ? runWorkerResultMonitor({
      butlerHome,
      butlerData,
      sessionId: binding.sessionId,
      chatId: telegramGateway.chatId ?? undefined,
      pollMs: input.workerResultPollMs,
      renderNotificationText: async ({ task }) => {
        const targetSessionId = task.origin?.origin_session_id?.trim() || binding.sessionId;
        const targetBinding = store.getBySessionId(targetSessionId) ?? binding;
        const actor = await lifecycle.actorForRoute({
          sessionId: targetBinding.sessionId,
          role: "butler",
          reason: "butler-fallback",
          workspacePath: targetBinding.workspacePath,
          projectId: targetBinding.projectId,
        });
        const result = await actor.handleInbound(buildWorkerCompletionEnvelope({
          accountId: "default",
          peerId: currentTelegramChatId()?.trim() || targetBinding.sessionId,
          task,
        }), {
          sessionId: targetBinding.sessionId,
          role: "butler",
          reason: "butler-fallback",
          workspacePath: targetBinding.workspacePath,
          projectId: targetBinding.projectId,
        });
        return result.text;
      },
      handlePlannedTaskReadyForReview: async (promotion) => {
        if (promotion.status !== "WORKER_DONE") return;
        const targetSessionId = promotion.originSessionId?.trim() || binding.sessionId;
        const targetBinding = store.getBySessionId(targetSessionId) ?? binding;
        const actor = await lifecycle.actorForRoute({
          sessionId: targetBinding.sessionId,
          role: "butler",
          reason: "butler-fallback",
          workspacePath: targetBinding.workspacePath,
          projectId: targetBinding.projectId,
        });
        await actor.handleInbound(buildPlannedReviewEnvelope({
          accountId: "default",
          peerId: currentTelegramChatId()?.trim() || targetBinding.sessionId,
          butlerData,
          plannedTaskId: promotion.plannedTaskId,
          workerTaskId: promotion.workerTaskId,
          attempt: promotion.attempt,
          reviewEventId: promotion.reviewEventId,
          status: promotion.status,
        }), {
          sessionId: targetBinding.sessionId,
          role: "butler",
          reason: "butler-fallback",
          workspacePath: targetBinding.workspacePath,
          projectId: targetBinding.projectId,
        });
      },
      deliverAction: async (activeSessionId, action, metadata) =>
        await deliverThroughEnabledGate(activeSessionId, action, metadata),
      shouldStop: telegramShouldStop,
      log: (line) => {
        process.stdout.write(`[worker-monitor] ${line}\n`);
      },
    }) : undefined;
    appWorkerResultMonitor = runWorkerResultMonitor({
      butlerHome,
      butlerData,
      sessionId: binding.sessionId,
      deliveryTarget: {
        transport: "app",
        accountId: "local",
        peerKind: "dm",
        peerId: "general",
      },
      sessionStore: store,
      pollMs: input.workerResultPollMs,
      renderNotificationText: async ({ task }) => {
        const targetSessionId = task.origin?.origin_session_id?.trim() || binding.sessionId;
        const targetBinding = store.getBySessionId(targetSessionId) ?? binding;
        const actor = await lifecycle.actorForRoute({
          sessionId: targetBinding.sessionId,
          role: "butler",
          reason: "app-worker-result",
          workspacePath: targetBinding.workspacePath,
          projectId: targetBinding.projectId,
        });
        const result = await actor.handleInbound(buildWorkerCompletionEnvelope({
          accountId: "local",
          peerId: targetBinding.sessionId,
          task,
        }), {
          sessionId: targetBinding.sessionId,
          role: "butler",
          reason: "app-worker-result",
          workspacePath: targetBinding.workspacePath,
          projectId: targetBinding.projectId,
        });
        return result.text;
      },
      handlePlannedTaskReadyForReview: async (promotion) => {
        if (promotion.status !== "WORKER_DONE") return;
        const targetSessionId = promotion.originSessionId?.trim() || binding.sessionId;
        const targetBinding = store.getBySessionId(targetSessionId) ?? binding;
        const actor = await lifecycle.actorForRoute({
          sessionId: targetBinding.sessionId,
          role: "butler",
          reason: "app-planned-worker-review",
          workspacePath: targetBinding.workspacePath,
          projectId: targetBinding.projectId,
        });
        await actor.handleInbound(buildPlannedReviewEnvelope({
          accountId: "local",
          peerId: targetBinding.sessionId,
          butlerData,
          plannedTaskId: promotion.plannedTaskId,
          workerTaskId: promotion.workerTaskId,
          attempt: promotion.attempt,
          reviewEventId: promotion.reviewEventId,
          status: promotion.status,
        }), {
          sessionId: targetBinding.sessionId,
          role: "butler",
          reason: "app-planned-worker-review",
          workspacePath: targetBinding.workspacePath,
          projectId: targetBinding.projectId,
        });
      },
      deliverAction: async (activeSessionId, action, metadata) =>
        await deliverThroughEnabledGate(activeSessionId, action, metadata),
      shouldStop: serviceShouldStop,
      log: (line) => {
        process.stdout.write(`[app-worker-monitor] ${line}\n`);
      },
    });

    writeStartupGraceMarker(butlerData);
    const startupMessage = buildStartupMessage(binding.modelRef, countRunningTasks(butlerData));
    const startupDelivery = telegramGateway.enabled ? await sendStartupNotification({
      butlerHome,
      chatId: telegramGateway.chatId ?? undefined,
      sessionId: binding.sessionId,
      startupMessage,
      sendTelegram: input.sendTelegram,
    }) : undefined;

    let shutdownReason: NativeButlerMainResult["shutdownReason"] = "bootstrap-only";
    if (input.waitForShutdown !== false) {
      shutdownReason = await waitForShutdown({
        shutdownFlagPath,
        signal: input.shutdownSignal,
        pollMs,
        onPoll: async () => {
          const summary = inboundDispatcher.poll({
            queue: new NativeInboundQueue(butlerData),
            server,
            store,
            deliveryGuard,
            deliverAction: deliverThroughEnabledGate,
            shouldHandleItem: shouldHandleAppInboundTurn(butlerData),
            telegramGroupId: currentTelegramChatId(),
            limit: 5,
            maxConcurrentSessions: 5,
            onOutcome: (outcome) => {
              process.stdout.write(
                `[inbound-queue] completed queueId=${outcome.queueId} handled=${outcome.handled} delivered=${outcome.delivered} failed=${outcome.failed}\n`,
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
      await Promise.race([
        workerResultMonitor,
        new Promise((resolve) => setTimeout(resolve, 12_000)),
      ]);
      await Promise.race([
        appWorkerResultMonitor,
        new Promise((resolve) => setTimeout(resolve, 12_000)),
      ]);
      await lifecycle.closeSession(binding.sessionId, shutdownReason === "flag" ? "controlled-stop" : "native-signal");
    }

    return {
      sessionId: binding.sessionId,
      startupMessage,
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
    stopTelegramPolling = true;
    store.close();
  }
}
