import type { GatewayDispatchResult } from "../../gateways/core/contracts.ts";
import type { ClaimedInboundEvent, NativeInboundQueue, QueuedInboundEvent } from "../../gateways/core/inbound-queue.ts";
import type { ArtifactRef, DeliveryResult, InboundEnvelope, OutboundAction, SessionTransportBinding } from "../../test-support/harness/contracts.ts";
import type { SessionBindingStore } from "../../test-support/harness/session-store.ts";
import { safeRuntimeFailure, type RuntimeFailureDiagnostic } from "../../integrations/providers/provider-errors.ts";
import type { DeliveryGuard } from "../transport/delivery-guard.ts";

export interface QueuedInboundServer {
  handleInbound(envelope: InboundEnvelope): Promise<GatewayDispatchResult>;
}

export interface ProcessQueuedInboundOptions {
  queue: NativeInboundQueue;
  server: QueuedInboundServer;
  store: SessionBindingStore;
  deliveryGuard: DeliveryGuard;
  deliverAction?: (
    sessionId: string,
    action: OutboundAction,
    metadata: Record<string, unknown>,
  ) => Promise<DeliveryResult>;
  shouldHandleItem?: (item: ClaimedInboundEvent) => boolean;
  telegramGroupId?: string;
  limit?: number;
  maxConcurrentSessions?: number;
  onOutcome?: (outcome: QueuedInboundOutcome) => void | Promise<void>;
  now?: () => Date;
}

export interface ProcessQueuedInboundSummary {
  claimed: number;
  handled: number;
  delivered: number;
  failed: number;
}

export interface QueuedInboundOutcome {
  queueId: string;
  sessionKey: string;
  handled: number;
  delivered: number;
  failed: number;
}

const DEFAULT_MAX_CONCURRENT_SESSIONS = 5;

function peerKindForTarget(target: SessionTransportBinding): OutboundAction["peer"]["kind"] {
  if (target.threadId) return "thread";
  if (target.transport === "app") return "dm";
  return "group";
}

function actionForTarget(input: {
  item: ClaimedInboundEvent;
  text: string;
  artifacts?: ArtifactRef[];
  target: SessionTransportBinding;
  generatedSessionTitle?: string;
  loadedSkillNames?: string[];
}): OutboundAction {
  return {
    actionId: `queued-inbound-reply:${input.item.queueId}:${input.target.transport}:${input.target.peerId}:${input.target.threadId ?? "main"}`,
    transport: input.target.transport,
    accountId: input.target.accountId,
    peer: {
      kind: peerKindForTarget(input.target),
      id: input.target.peerId,
      threadId: input.target.threadId,
    },
    message: {
      text: input.text,
      artifacts: input.artifacts && input.artifacts.length > 0 ? input.artifacts : undefined,
      replyToMessageId: input.item.envelope.message.id,
    },
    metadata: {
      source: "gateway/queued-inbound.ts",
      kind: "final_result",
      queueId: input.item.queueId,
      originalTransport: input.item.envelope.transport,
      turnId: input.item.envelope.routingHints?.turnId,
      generatedSessionTitle: input.generatedSessionTitle,
      loadedSkillNames: input.loadedSkillNames ?? [],
    },
  };
}

function failureActionForOriginalInbound(input: {
  item: ClaimedInboundEvent;
  error?: unknown;
  failure?: RuntimeFailureDiagnostic;
}): OutboundAction | null {
  const turnId = input.item.envelope.routingHints?.turnId?.trim();
  const sessionId = input.item.envelope.routingHints?.sessionId?.trim();
  if (!turnId || !sessionId) return null;
  const safeFailure = input.failure ?? safeRuntimeFailure(input.error);
  return {
    actionId: `queued-inbound-failure:${input.item.queueId}:${input.item.envelope.transport}:${turnId}`,
    transport: input.item.envelope.transport,
    accountId: input.item.envelope.accountId,
    peer: input.item.envelope.peer,
    message: {
      text: safeFailure.message,
      replyToMessageId: input.item.envelope.message.id,
    },
    metadata: {
      source: "gateway/queued-inbound.ts",
      kind: "turn_failed",
      queueId: input.item.queueId,
      originalTransport: input.item.envelope.transport,
      sessionId,
      turnId,
      safeErrorCode: safeFailure.code,
      provider: safeFailure.provider,
      api: safeFailure.api,
      statusCode: safeFailure.statusCode,
      endpoint: safeFailure.endpoint,
      model: safeFailure.model,
      retryable: safeFailure.retryable,
      dispatchStatus: safeFailure.cause?.startsWith("dispatch_status=")
        ? safeFailure.cause.slice("dispatch_status=".length).split(" ", 1)[0]
        : undefined,
    },
  };
}

function reactivateHintedSessionForInbound(input: {
  item: ClaimedInboundEvent;
  store: SessionBindingStore;
  now?: () => Date;
}): void {
  const sessionId = input.item.envelope.routingHints?.sessionId?.trim();
  if (!sessionId) return;
  const session = input.store.getBySessionId(sessionId);
  if (!session) return;
  if (session.lifecycleState === "active" || session.lifecycleState === "closing") return;
  input.store.updateLifecycleState(sessionId, "active", input.now?.().toISOString());
}

function failureForDispatchResult(result: Exclude<GatewayDispatchResult, { status: "handled" }>): RuntimeFailureDiagnostic {
  if (result.status === "unroutable") {
    return {
      code: "gateway_unroutable",
      message: "Butler could not route this turn to an active session.",
      retryable: true,
      cause: `dispatch_status=unroutable reason=${result.reason}`,
    };
  }
  return {
    code: "gateway_missing_handler",
    message: "Butler routed this turn, but no runtime handler is available.",
    retryable: true,
    cause: `dispatch_status=missing-handler role=${result.route.role}`,
  };
}

async function deliverFailureForOriginalInbound(input: {
  item: ClaimedInboundEvent;
  deliverAction: (
    sessionId: string,
    action: OutboundAction,
    metadata: Record<string, unknown>,
  ) => Promise<DeliveryResult>;
  error?: unknown;
  failure?: RuntimeFailureDiagnostic;
  queueSource: string;
}): Promise<boolean> {
  const failureAction = failureActionForOriginalInbound({
    item: input.item,
    error: input.error,
    failure: input.failure,
  });
  const sessionId = input.item.envelope.routingHints?.sessionId?.trim();
  if (!failureAction || !sessionId) return false;
  const delivery = await input.deliverAction(sessionId, failureAction, {
    source: input.queueSource,
    queueId: input.item.queueId,
  });
  return delivery.ok;
}

function targetActionsForResult(input: {
  item: ClaimedInboundEvent;
  result: Extract<GatewayDispatchResult, { status: "handled" }>;
  store: SessionBindingStore;
  telegramGroupId?: string;
}): OutboundAction[] {
  const text = input.result.handlerResult.metadata?.text;
  if (typeof text !== "string" || !text.trim()) return [];
  const artifacts = artifactRefsFromMetadata(input.result.handlerResult.metadata?.artifacts);
  const generatedSessionTitle =
    typeof input.result.handlerResult.metadata?.generatedSessionTitle === "string"
      ? input.result.handlerResult.metadata.generatedSessionTitle
      : undefined;
  const loadedSkillNames = Array.isArray(input.result.handlerResult.metadata?.loadedSkillNames)
    ? input.result.handlerResult.metadata.loadedSkillNames.filter((name): name is string => typeof name === "string")
    : [];

  const binding = input.store.getBySessionId(input.result.route.sessionId);
  const actorRecordedDurableFinal =
    input.result.handlerResult.metadata?.durableFinalRecorded === true;
  const targets = binding?.transportBindings.length
    ? binding.transportBindings
    : input.telegramGroupId?.trim()
      ? [{
          transport: "telegram",
          accountId: "default",
          peerId: input.telegramGroupId.trim(),
        }]
      : [];

  return targets
    .filter((target) =>
      !(target.transport === "app" &&
        input.item.envelope.transport === "app" &&
        actorRecordedDurableFinal),
    )
    .map((target) => actionForTarget({
      item: input.item,
      text,
      artifacts,
      target,
      generatedSessionTitle,
      loadedSkillNames,
    }));
}

function artifactRefsFromMetadata(value: unknown): ArtifactRef[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item, index) => artifactRefFromRecord(item, index))
    .filter((item): item is ArtifactRef => item !== null)
    .slice(0, 12);
}

function artifactRefFromRecord(
  item: Record<string, unknown>,
  index: number,
): ArtifactRef | null {
  const title = safeText(item.title) ?? safeText(item.safePathLabel) ?? `Artifact ${index + 1}`;
  const id = safeText(item.id) ?? `artifact-${index + 1}`;
  const safePathLabel =
    safeText(item.safePathLabel) ?? safePathLabelFromLocalPath(item.localPath);
  if (!safePathLabel && !safeText(item.url)) return null;
  return {
    id,
    kind: artifactKind(item.kind),
    title,
    safePathLabel,
    mimeType: safeText(item.mimeType),
    url: safeText(item.url),
    sizeBytes: typeof item.sizeBytes === "number" ? item.sizeBytes : undefined,
    createdAt: safeText(item.createdAt),
    metadata: isRecord(item.metadata) ? item.metadata : undefined,
  };
}

function artifactKind(value: unknown): ArtifactRef["kind"] {
  const kind = typeof value === "string" ? value : "";
  if (
    kind === "csv_file" ||
    kind === "table_file" ||
    kind === "chart_file" ||
    kind === "image" ||
    kind === "document" ||
    kind === "code" ||
    kind === "report" ||
    kind === "file"
  ) return kind;
  return "unknown";
}

function safePathLabelFromLocalPath(value: unknown): string | undefined {
  const text = safeText(value);
  if (!text) return undefined;
  return text.split(/[\\/]/u).filter(Boolean).at(-1);
}

function safeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const withoutControl = Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? " " : char;
  }).join("");
  const text = withoutControl.replace(/\s+/gu, " ").trim();
  return text ? text.slice(0, 240) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function processClaimedQueuedInboundItem(input: {
  item: ClaimedInboundEvent;
  options: ProcessQueuedInboundOptions;
}): Promise<ProcessQueuedInboundSummary> {
  const { item, options } = input;
  const summary: ProcessQueuedInboundSummary = {
    claimed: 1,
    handled: 0,
    delivered: 0,
    failed: 0,
  };
  const deliverAction = options.deliverAction ??
    ((sessionId: string, action: OutboundAction, metadata: Record<string, unknown>) =>
      options.deliveryGuard.deliver(sessionId, action, metadata));

  try {
    if (options.shouldHandleItem && !options.shouldHandleItem(item)) {
      options.queue.complete(item, {
        dispatchStatus: "skipped-terminal-turn",
        handled: false,
      }, options.now?.());
      return summary;
    }
    reactivateHintedSessionForInbound({
      item,
      store: options.store,
      now: options.now,
    });
    const result = await options.server.handleInbound(item.envelope);
    if (result.status !== "handled") {
      summary.failed += 1;
      const failure = failureForDispatchResult(result);
      const delivered = await deliverFailureForOriginalInbound({
        item,
        deliverAction,
        failure,
        queueSource: "gateway/queued-inbound.ts#dispatch-failure",
      });
      if (delivered) summary.delivered += 1;
      options.queue.fail(
        item,
        failure.message,
        {
          source: "gateway/queued-inbound.ts",
          dispatchStatus: result.status,
          failure: {
            code: failure.code,
            retryable: failure.retryable,
            cause: failure.cause,
          },
        },
        options.now?.(),
      );
      return summary;
    }
    if (result.status === "handled") {
      summary.handled += 1;
      const actions = targetActionsForResult({
        item,
        result,
        store: options.store,
        telegramGroupId: options.telegramGroupId,
      });
      for (const action of actions) {
        const delivery = await deliverAction(result.route.sessionId, action, {
          source: "gateway/queued-inbound.ts",
          queueId: item.queueId,
        });
        if (delivery.ok) summary.delivered += 1;
      }
    }
    options.queue.complete(item, {
      dispatchStatus: result.status,
      handled: result.status === "handled",
    }, options.now?.());
  } catch (error) {
    summary.failed += 1;
    const safeFailure = safeRuntimeFailure(error);
    const delivered = await deliverFailureForOriginalInbound({
      item,
      deliverAction,
      error,
      queueSource: "gateway/queued-inbound.ts#failure",
    });
    if (delivered) summary.delivered += 1;
    options.queue.fail(
      item,
      safeFailure.message,
      {
        source: "gateway/queued-inbound.ts",
        failure: {
          code: safeFailure.code,
          provider: safeFailure.provider,
          api: safeFailure.api,
          statusCode: safeFailure.statusCode,
          endpoint: safeFailure.endpoint,
          model: safeFailure.model,
          retryable: safeFailure.retryable,
          cause: safeFailure.cause,
        },
      },
      options.now?.(),
    );
  }

  return summary;
}

export async function processQueuedInboundEvents(
  options: ProcessQueuedInboundOptions,
): Promise<ProcessQueuedInboundSummary> {
  const items = options.queue.claim(options.limit ?? 5);
  const summary: ProcessQueuedInboundSummary = {
    claimed: items.length,
    handled: 0,
    delivered: 0,
    failed: 0,
  };
  for (const item of items) {
    const result = await processClaimedQueuedInboundItem({
      item,
      options,
    });
    summary.handled += result.handled;
    summary.delivered += result.delivered;
    summary.failed += result.failed;
    try {
      await options.onOutcome?.({
        queueId: item.queueId,
        sessionKey: sessionKeyForQueuedInbound(item),
        handled: result.handled,
        delivered: result.delivered,
        failed: result.failed,
      });
    } catch {}
  }

  return summary;
}

function sessionKeyForQueuedInbound(item: QueuedInboundEvent): string {
  const hintedSessionId = item.envelope.routingHints?.sessionId?.trim();
  if (hintedSessionId) return hintedSessionId;
  return [
    item.envelope.transport,
    item.envelope.accountId,
    item.envelope.peer.kind,
    item.envelope.peer.id,
    item.envelope.peer.parentId ?? "root",
  ].join(":");
}

function maxConcurrentSessionsFor(options: ProcessQueuedInboundOptions): number {
  const configured = options.maxConcurrentSessions;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_MAX_CONCURRENT_SESSIONS;
  }
  return Math.max(1, Math.floor(configured));
}

export class QueuedInboundDispatcher {
  private readonly activeSessionKeys = new Set<string>();
  private readonly activeTasks = new Set<Promise<void>>();

  poll(options: ProcessQueuedInboundOptions): ProcessQueuedInboundSummary {
    const maxConcurrentSessions = maxConcurrentSessionsFor(options);
    const availableSlots = Math.max(0, maxConcurrentSessions - this.activeTasks.size);
    const claimLimit = Math.min(options.limit ?? DEFAULT_MAX_CONCURRENT_SESSIONS, availableSlots);
    const summary: ProcessQueuedInboundSummary = {
      claimed: 0,
      handled: 0,
      delivered: 0,
      failed: 0,
    };
    if (claimLimit <= 0) return summary;

    const batchSessionKeys = new Set<string>();
    const items = options.queue.claimEligible(claimLimit, (event) => {
      const sessionKey = sessionKeyForQueuedInbound(event);
      if (this.activeSessionKeys.has(sessionKey) || batchSessionKeys.has(sessionKey)) {
        return false;
      }
      batchSessionKeys.add(sessionKey);
      return true;
    });
    summary.claimed = items.length;

    for (const item of items) {
      const sessionKey = sessionKeyForQueuedInbound(item);
      this.activeSessionKeys.add(sessionKey);
      const task = this.handleItem(item, options, summary)
        .catch(() => {
          summary.failed += 1;
        })
        .finally(() => {
          this.activeSessionKeys.delete(sessionKey);
          this.activeTasks.delete(task);
        });
      this.activeTasks.add(task);
    }

    return summary;
  }

  async waitForIdle(): Promise<void> {
    while (this.activeTasks.size > 0) {
      await Promise.allSettled([...this.activeTasks]);
    }
  }

  private async handleItem(
    item: ClaimedInboundEvent,
    options: ProcessQueuedInboundOptions,
    summary: ProcessQueuedInboundSummary,
  ): Promise<void> {
    const result = await processClaimedQueuedInboundItem({
      item,
      options,
    });
    summary.handled += result.handled;
    summary.delivered += result.delivered;
    summary.failed += result.failed;
    try {
      await options.onOutcome?.({
        queueId: item.queueId,
        sessionKey: sessionKeyForQueuedInbound(item),
        handled: result.handled,
        delivered: result.delivered,
        failed: result.failed,
      });
    } catch {}
  }
}
