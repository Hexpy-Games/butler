import type { GatewayDispatchResult } from "../../gateways/core/contracts.ts";
import type { ClaimedInboundEvent, NativeInboundQueue, QueuedInboundEvent } from "../../gateways/core/inbound-queue.ts";
import type { ArtifactRef, DeliveryResult, InboundEnvelope, OutboundAction, SessionTransportBinding } from "../../test-support/harness/contracts.ts";
import type { SessionBindingStore } from "../../test-support/harness/session-store.ts";
import {
  safeRuntimeFailure,
  type RuntimeFailureDiagnostic,
} from "../../integrations/providers/provider-errors.ts";
import {
  recoverableLimitedDeliveryForError,
} from "../../agent/turn/recoverable-delivery.ts";
import {
  clearTurnContextAtom,
  isTurnSchedulerContinuationYieldError,
} from "../../agent/turn/turn-continuation-context.ts";
import { safeLimitationText } from "../../agent/turn/runtime-delivery-state.ts";
import type { DeliveryGuard } from "../transport/delivery-guard.ts";
import { continuationBackoffForFailure } from "./continuation-backoff.ts";
import {
  principalTurnCancellationRecorded,
  registerPrincipalTurnAbortController,
  markPrincipalTurnCancellationDelivery,
} from "../../agent/turn/principal-turn-cancellation-registry.ts";
import { runtimeTurnAbortError } from "../../agent/turn/native/policy/turn-errors.ts";

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
  dispatchTimeoutMs?: number;
  processingLeaseMs?: number;
  onOutcome?: (outcome: QueuedInboundOutcome) => void | Promise<void>;
  now?: () => Date;
}

export interface ProcessQueuedInboundSummary {
  claimed: number;
  handled: number;
  delivered: number;
  failed: number;
  quiescence?: Promise<void>;
}

export interface QueuedInboundOutcome {
  queueId: string;
  sessionKey: string;
  handled: number;
  delivered: number;
  failed: number;
}

const DEFAULT_MAX_CONCURRENT_SESSIONS = 5;
const DEFAULT_DISPATCH_TIMEOUT_MS = 0;
const DEFAULT_PROCESSING_LEASE_MS = 16 * 60 * 1000;

class QueuedInboundDispatchTimeoutError extends Error {
  readonly code = "inbound_dispatch_timeout";

  constructor(
    readonly timeoutMs: number,
    readonly quiescence: Promise<void>,
  ) {
    super(
      "Butler did not finish this queued request before the dispatch lease expired. Retry the turn.",
    );
    this.name = "QueuedInboundDispatchTimeoutError";
  }
}

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
      dispatchClaimId: input.item.processing.claimId,
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
  const safeErrorCause = safeFailure.code === "gateway_failed"
    ? ""
    : safeLimitationText(safeFailure.cause, "");
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
      dispatchClaimId: input.item.processing.claimId,
      originalTransport: input.item.envelope.transport,
      sessionId,
      turnId,
      safeErrorCode: safeFailure.code,
      safeErrorCause: safeErrorCause || undefined,
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

function limitedDeliveryActionForOriginalInbound(input: {
  item: ClaimedInboundEvent;
  text: string | null;
  delivery: NonNullable<ReturnType<typeof recoverableLimitedDeliveryForError>>["delivery"];
}): OutboundAction | null {
  const turnId = input.item.envelope.routingHints?.turnId?.trim();
  const sessionId = input.item.envelope.routingHints?.sessionId?.trim();
  if (!turnId || !sessionId) return null;
  return {
    actionId: `queued-inbound-limited:${input.item.queueId}:${input.item.envelope.transport}:${turnId}`,
    transport: input.item.envelope.transport,
    accountId: input.item.envelope.accountId,
    peer: input.item.envelope.peer,
    message: {
      text: input.text ?? "",
      replyToMessageId: input.item.envelope.message.id,
    },
    metadata: {
      source: "gateway/queued-inbound.ts",
      kind: "final_result",
      queueId: input.item.queueId,
      dispatchClaimId: input.item.processing.claimId,
      originalTransport: input.item.envelope.transport,
      sessionId,
      turnId,
      noVisibleReply: input.text === null,
      visibleLimitedReply: input.text !== null,
      deliveryState: input.delivery.delivery_state,
      limitationCodes: input.delivery.limitation_codes,
      limitations: input.delivery.limitations,
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
  let unregisterTurnController: (() => void) | undefined;

  try {
    if (options.shouldHandleItem && !options.shouldHandleItem(item)) {
      completeQueueClaim(options, item, {
        dispatchStatus: "skipped-terminal-turn",
        handled: false,
      });
      return summary;
    }
    if (principalCancellationRecordedForItem(options, item)) {
      completePrincipalCancelledQueueClaim(options, item);
      return summary;
    }
    reactivateHintedSessionForInbound({
      item,
      store: options.store,
      now: options.now,
    });
    const controller = new AbortController();
    const turnId = item.envelope.routingHints?.turnId?.trim();
    if (turnId) {
      unregisterTurnController = registerPrincipalTurnAbortController({
        butlerData: options.queue.butlerData,
        turnId,
        queueId: item.queueId,
        dispatchClaimId: item.processing.claimId,
        controller,
      });
    }
    const result = await withDispatchTimeout(
      {
        controller,
        run: (signal) =>
          options.server.handleInbound({
            ...item.envelope,
            signal,
            raw: {
              ...(isRecord(item.envelope.raw) ? item.envelope.raw : {}),
              dispatchClaimId: item.processing.claimId,
              queueId: item.queueId,
              ...(item.metadata.sameLogicalTurnContinuation === true
                ? {
                  sameLogicalTurnContinuation: true,
                  contextAtomId: item.metadata.contextAtomId,
                  continuationForQueueId: item.metadata.continuationForQueueId,
                  checkpointId: item.metadata.checkpointId,
                  schedulerItemId: item.queueId,
                }
                : {}),
            },
          }),
      },
      dispatchTimeoutMsFor(options),
    );
    if (principalCancellationRecordedForItem(options, item)) {
      completePrincipalCancelledQueueClaim(options, item);
      return summary;
    }
    if (result.status !== "handled") {
      summary.failed += 1;
      const failure = failureForDispatchResult(result);
      const terminalRecorded = failQueueClaim(
        options,
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
      );
      if (!terminalRecorded) return summary;
      const delivered = await deliverFailureForOriginalInbound({
        item,
        deliverAction,
        failure,
        queueSource: "gateway/queued-inbound.ts#dispatch-failure",
      });
      if (delivered) summary.delivered += 1;
      return summary;
    }
    if (result.status === "handled") {
      const actions = targetActionsForResult({
        item,
        result,
        store: options.store,
        telegramGroupId: options.telegramGroupId,
      });
      const terminalRecorded = completeQueueClaim(options, item, {
        dispatchStatus: result.status,
        handled: true,
      });
      if (!terminalRecorded) return summary;
      summary.handled += 1;
      for (const action of actions) {
        if (principalCancellationRecordedForItem(options, item)) break;
        const delivery = await deliverAction(result.route.sessionId, action, {
          source: "gateway/queued-inbound.ts",
          queueId: item.queueId,
        });
        if (delivery.ok) summary.delivered += 1;
      }
    }
  } catch (error) {
    summary.quiescence = dispatchQuiescenceForError(error);
    const sessionId = item.envelope.routingHints?.sessionId?.trim();
    const turnId = item.envelope.routingHints?.turnId?.trim();
    if (principalCancellationRecordedForItem(options, item)) {
      completePrincipalCancelledQueueClaim(options, item);
      return summary;
    }
    if (isTurnSchedulerContinuationYieldError(error) && sessionId && turnId) {
      const scheduled = scheduleSameLogicalTurnContinuation({
        queue: options.queue,
        item,
        turnId,
        contextAtomId: error.contextAtomId,
        checkpointId: error.checkpointId ?? error.contextAtomId,
        sourceErrorCode: error.sourceErrorCode,
        retryableProviderFailureStreak: error.retryableProviderFailureStreak,
        now: options.now?.(),
      });
      if (!scheduled) {
        if (principalCancellationRecordedForItem(options, item)) {
          completePrincipalCancelledQueueClaim(options, item);
          return summary;
        }
        clearTurnContextAtom({
          butlerData: options.queue.butlerData,
          sessionId,
          turnId,
        });
        const failure: RuntimeFailureDiagnostic = {
          code: "turn_scheduler_continuation_schedule_failed",
          message: "Butler could not commit the next continuation owner.",
          retryable: true,
        };
        summary.failed += 1;
        const terminalRecorded = failQueueClaim(options, item, failure.message, {
          source: "gateway/queued-inbound.ts#scheduler-continuation",
          failure,
        });
        if (!terminalRecorded) return summary;
        const delivered = await deliverFailureForOriginalInbound({
          item,
          deliverAction,
          failure,
          queueSource: "gateway/queued-inbound.ts#scheduler-continuation-failure",
        });
        if (delivered) summary.delivered += 1;
        return summary;
      }
      const terminalRecorded = completeQueueClaim(options, item, {
        dispatchStatus: "continuing",
        handled: true,
        continuationScheduled: true,
        contextAtomId: error.contextAtomId,
        checkpointId: error.checkpointId,
        schedulerItemId: scheduled.queueId,
      });
      if (!terminalRecorded) return summary;
      summary.handled += 1;
      return summary;
    }
    const limitedDelivery = recoverableLimitedDeliveryForError(error);
    if (limitedDelivery && sessionId) {
      const terminalRecorded = completeQueueClaim(options, item, {
        dispatchStatus: "handled",
        handled: true,
      });
      if (!terminalRecorded) return summary;
      summary.handled += 1;
      const action = limitedDeliveryActionForOriginalInbound({
        item,
        text: limitedDelivery.text,
        delivery: limitedDelivery.delivery,
      });
      if (action) {
        const delivery = await deliverAction(sessionId, action, {
          source: "gateway/queued-inbound.ts#limited-delivery",
          queueId: item.queueId,
        });
        if (delivery.ok) summary.delivered += 1;
      }
      return summary;
    }
    summary.failed += 1;
    const safeFailure = safeFailureForQueuedInboundError(error);
    const terminalRecorded = failQueueClaim(
      options,
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
    );
    if (!terminalRecorded) return summary;
    const delivered = await deliverFailureForOriginalInbound({
      item,
      deliverAction,
      failure: safeFailure,
      queueSource: "gateway/queued-inbound.ts#failure",
    });
    if (delivered) summary.delivered += 1;
  } finally {
    unregisterTurnController?.();
  }

  return summary;
}

function scheduleSameLogicalTurnContinuation(input: {
  queue: NativeInboundQueue;
  item: ClaimedInboundEvent;
  turnId: string;
  contextAtomId: string;
  checkpointId: string;
  sourceErrorCode?: string;
  retryableProviderFailureStreak?: number;
  now?: Date;
}): QueuedInboundEvent | null {
  try {
    if (principalTurnCancellationRecorded({
      butlerData: input.queue.butlerData,
      turnId: input.turnId,
    })) return null;
    const now = input.now ?? new Date();
    const backoff = continuationBackoffForFailure({
      sourceErrorCode: input.sourceErrorCode,
      retryStreak: input.retryableProviderFailureStreak ?? 1,
      now,
    });
    return input.queue.enqueue({
      ...input.item.envelope,
      routingHints: {
        ...input.item.envelope.routingHints,
        turnId: input.turnId,
      },
    }, {
      source: "gateway/queued-inbound.ts#scheduler-continuation",
      continuationForQueueId: input.item.queueId,
      continuationTurnId: input.turnId,
      contextAtomId: input.contextAtomId,
      checkpointId: input.checkpointId,
      sameLogicalTurnContinuation: true,
      ...(backoff ? {
        notBefore: backoff.notBefore,
        continuationBackoffMs: backoff.delayMs,
        continuationFailureCode: input.sourceErrorCode,
      } : {}),
    }, now);
  } catch {
    return null;
  }
}

function principalCancellationRecordedForItem(
  options: ProcessQueuedInboundOptions,
  item: ClaimedInboundEvent,
): boolean {
  const turnId = item.envelope.routingHints?.turnId?.trim();
  return Boolean(turnId && principalTurnCancellationRecorded({
    butlerData: options.queue.butlerData,
    turnId,
  }));
}

function completePrincipalCancelledQueueClaim(
  options: ProcessQueuedInboundOptions,
  item: ClaimedInboundEvent,
): boolean {
  const completed = completeQueueClaim(options, item, {
    dispatchStatus: "cancelled-principal-turn",
    handled: false,
    cancelled: true,
  });
  const turnId = item.envelope.routingHints?.turnId?.trim();
  if (completed && turnId) {
    const identity = {
        butlerData: options.queue.butlerData,
        turnId,
        queueId: item.queueId,
        dispatchClaimId: item.processing.claimId,
      };
    queueMicrotask(() => {
      markPrincipalTurnCancellationDelivery(identity, "completed");
    });
  }
  return completed;
}

function completeQueueClaim(
  options: ProcessQueuedInboundOptions,
  item: ClaimedInboundEvent,
  metadata: Record<string, unknown>,
): boolean {
  try {
    return options.queue.complete(item, metadata, options.now?.());
  } catch {
    return false;
  }
}

function failQueueClaim(
  options: ProcessQueuedInboundOptions,
  item: ClaimedInboundEvent,
  message: string,
  metadata: Record<string, unknown>,
): boolean {
  try {
    return options.queue.fail(item, message, metadata, options.now?.());
  } catch {
    return false;
  }
}

export async function processQueuedInboundEvents(
  options: ProcessQueuedInboundOptions,
): Promise<ProcessQueuedInboundSummary> {
  options.queue.recoverStaleProcessing({
    staleAfterMs: processingLeaseMsFor(options),
    now: options.now?.(),
  });
  const items = options.queue.claimEligible(
    options.limit ?? 5,
    () => true,
    options.now?.(),
    processingLeaseMsFor(options),
  );
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
    await notifyQueuedInboundOutcome(options, item, result);
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

function dispatchTimeoutMsFor(options: ProcessQueuedInboundOptions): number {
  const configured = options.dispatchTimeoutMs;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_DISPATCH_TIMEOUT_MS;
  }
  return Math.max(0, Math.floor(configured));
}

function processingLeaseMsFor(options: ProcessQueuedInboundOptions): number {
  const configured = options.processingLeaseMs;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_PROCESSING_LEASE_MS;
  }
  return Math.max(1, Math.floor(configured));
}

function safeFailureForQueuedInboundError(
  error: unknown,
): RuntimeFailureDiagnostic {
  if (error instanceof QueuedInboundDispatchTimeoutError) {
    return {
      code: error.code,
      message: error.message,
      retryable: true,
      cause: `dispatch_timeout_ms=${error.timeoutMs}`,
    };
  }
  return safeRuntimeFailure(error);
}

function dispatchQuiescenceForError(error: unknown): Promise<void> | undefined {
  return error instanceof QueuedInboundDispatchTimeoutError
    ? error.quiescence
    : undefined;
}

async function withDispatchTimeout<T>(
  input: {
    run: (signal: AbortSignal) => Promise<T>;
    controller: AbortController;
  },
  timeoutMs: number,
): Promise<T> {
  throwIfDispatchAborted(input.controller.signal);
  if (timeoutMs <= 0) {
    return await input.run(input.controller.signal);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const promise = input.run(input.controller.signal);
    const quiescence = promise.then(
      () => undefined,
      () => undefined,
    );
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => {
            const error = new QueuedInboundDispatchTimeoutError(
              timeoutMs,
              quiescence,
            );
            input.controller.abort(
              error,
            );
            reject(error);
          },
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function throwIfDispatchAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason ?? runtimeTurnAbortError();
}

export class QueuedInboundDispatcher {
  private readonly activeSessionKeys = new Set<string>();
  private readonly activeQueueIds = new Set<string>();
  private readonly activeTasks = new Set<Promise<void>>();

  poll(options: ProcessQueuedInboundOptions): ProcessQueuedInboundSummary {
    const maxConcurrentSessions = maxConcurrentSessionsFor(options);
    options.queue.recoverStaleProcessing({
      staleAfterMs: processingLeaseMsFor(options),
      now: options.now?.(),
      shouldRecover: (record) => !this.activeQueueIds.has(record.queueId),
    });
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
    const items = options.queue.claimEligible(
      claimLimit,
      (event) => {
        const sessionKey = sessionKeyForQueuedInbound(event);
        if (this.activeSessionKeys.has(sessionKey) || batchSessionKeys.has(sessionKey)) {
          return false;
        }
        batchSessionKeys.add(sessionKey);
        return true;
      },
      options.now?.(),
      processingLeaseMsFor(options),
    );
    summary.claimed = items.length;

    for (const item of items) {
      const sessionKey = sessionKeyForQueuedInbound(item);
      this.activeSessionKeys.add(sessionKey);
      this.activeQueueIds.add(item.queueId);
      let quiescence: Promise<void> | undefined;
      const task = this.handleItem(item, options, summary)
        .then((settled) => {
          quiescence = settled.quiescence;
          if (settled.quiescence) {
            void settled.quiescence.finally(() => {
              this.activeSessionKeys.delete(sessionKey);
              this.activeQueueIds.delete(item.queueId);
            });
          }
        })
        .catch(() => {
          summary.failed += 1;
        })
        .finally(() => {
          if (!quiescence) {
            this.activeSessionKeys.delete(sessionKey);
            this.activeQueueIds.delete(item.queueId);
          }
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
  ): Promise<{ quiescence?: Promise<void> }> {
    const result = await processClaimedQueuedInboundItem({
      item,
      options,
    });
    summary.handled += result.handled;
    summary.delivered += result.delivered;
    summary.failed += result.failed;
    await notifyQueuedInboundOutcome(options, item, result);
    return { quiescence: result.quiescence };
  }
}

async function notifyQueuedInboundOutcome(
  options: ProcessQueuedInboundOptions,
  item: ClaimedInboundEvent,
  result: Pick<ProcessQueuedInboundSummary, "handled" | "delivered" | "failed">,
): Promise<void> {
  if (!options.onOutcome) return;
  const outcome = {
    queueId: item.queueId,
    sessionKey: sessionKeyForQueuedInbound(item),
    handled: result.handled,
    delivered: result.delivered,
    failed: result.failed,
  };
  try {
    await options.onOutcome(outcome);
  } catch (error) {
    const failure = safeRuntimeFailure(error);
    console.warn(
      `[queued-inbound] outcome callback failed queueId=${outcome.queueId} code=${failure.code ?? "unknown"} message=${failure.message}`,
    );
  }
}
