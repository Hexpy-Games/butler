import type {
  GatewayDispatchResult,
} from "../../../gateways/core/contracts.ts";
import type { ChangedFileDetail } from "../../../agent/btcc/index.ts";
import type {
  ClaimedInboundEvent,
  NativeInboundQueue,
  QueuedInboundEvent,
} from "../../../gateways/core/inbound-queue.ts";
import type {
  ArtifactRef,
  DeliveryResult,
  OutboundAction,
  SessionTransportBinding,
} from "../../../test-support/harness/contracts.ts";
import type { SessionBindingStore } from "../../../test-support/harness/session-store.ts";
import type { DeliveryGuard } from "../../transport/delivery-guard.ts";
import {
  controlAckActions,
  isMatchingClaimedAppTarget,
} from "./control-ack-action.ts";
import { bindQueuedInboundSession } from "./queued-inbound-session-binder.ts";

type BtccInboundServer = {
  handleInbound(
    envelope: ClaimedInboundEvent["envelope"],
  ): Promise<GatewayDispatchResult>;
};

export type BtccInboundDispatchSummary = {
  claimed: number;
  handled: number;
  delivered: number;
  failed: number;
  interrupted: number;
};

export type BtccInboundDispatchOptions = {
  queue: NativeInboundQueue;
  server: BtccInboundServer;
  store: SessionBindingStore;
  deliveryGuard: DeliveryGuard;
  deliverAction?: (
    sessionId: string,
    action: OutboundAction,
    metadata: Record<string, unknown>,
  ) => Promise<DeliveryResult>;
  limit?: number;
  maxConcurrentSessions?: number;
  processingLeaseMs?: number;
  onOutcome?: (outcome: BtccInboundDispatchSummary & {
    queueId: string;
    sessionKey: string;
  }) => void | Promise<void>;
  now?: () => Date;
};

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_LEASE_MS = 16 * 60 * 1000;

export class BtccInboundDispatcher {
  private readonly activeSessions = new Set<string>();
  private readonly activeQueueIds = new Set<string>();
  private readonly activeTasks = new Set<Promise<void>>();

  poll(options: BtccInboundDispatchOptions): BtccInboundDispatchSummary {
    const summary = emptySummary();
    options.queue.recoverStaleProcessing({
      staleAfterMs: options.processingLeaseMs ?? DEFAULT_LEASE_MS,
      now: options.now?.(),
      shouldRecover: (record) =>
        !this.activeQueueIds.has(record.queueId),
    });

    const capacity = Math.max(
      0,
      (options.maxConcurrentSessions ?? DEFAULT_CONCURRENCY) - this.activeTasks.size,
    );
    const batchSessions = new Set<string>();
    const items = options.queue.claimEligible(
      Math.min(options.limit ?? DEFAULT_CONCURRENCY, capacity),
      (event) => {
        return claimableSession(event, this.activeSessions, batchSessions);
      },
      options.now?.(),
      options.processingLeaseMs ?? DEFAULT_LEASE_MS,
    );
    summary.claimed = items.length;

    for (const item of items) {
      this.start(item, options, summary);
    }
    return summary;
  }

  async waitForIdle(): Promise<void> {
    while (this.activeTasks.size > 0) {
      await Promise.allSettled([...this.activeTasks]);
    }
  }

  private start(
    item: ClaimedInboundEvent,
    options: BtccInboundDispatchOptions,
    aggregate: BtccInboundDispatchSummary,
  ): void {
    const sessionKey = sessionKeyFor(item);
    this.activeSessions.add(sessionKey);
    this.activeQueueIds.add(item.queueId);
    const task = dispatchItem(item, options)
      .then(async (result) => {
        addSummary(aggregate, result);
        await options.onOutcome?.({ ...result, queueId: item.queueId, sessionKey });
      })
      .catch(() => {
        aggregate.failed += 1;
      })
      .finally(() => {
        this.activeSessions.delete(sessionKey);
        this.activeQueueIds.delete(item.queueId);
        this.activeTasks.delete(task);
      });
    this.activeTasks.add(task);
  }
}

async function dispatchItem(
  item: ClaimedInboundEvent,
  options: BtccInboundDispatchOptions,
): Promise<BtccInboundDispatchSummary> {
  const summary = { ...emptySummary(), claimed: 1 };
  bindQueuedInboundSession(item.envelope, options.store);
  reactivateSession(item, options.store, options.now?.());
  try {
    const result = await options.server.handleInbound(item.envelope);
    if (result.status !== "handled") {
      const terminalDelivery = await deliverGatewayFailure(item, result, options);
      if (terminalDelivery === false) {
        options.queue.parkForProcessReplacement(item, "App terminal failure delivery was not committed.", {
          source: "gateway/btcc/btcc-inbound-dispatcher.ts",
          dispatchStatus: "terminal-delivery-interrupted",
        }, options.now?.());
        summary.interrupted = 1;
        return summary;
      }
      if (terminalDelivery === undefined) {
        options.queue.fail(item, `BTCC gateway ${result.status}`, {
          source: "gateway/btcc/btcc-inbound-dispatcher.ts",
          dispatchStatus: result.status,
        }, options.now?.());
        summary.failed = 1;
        return summary;
      }
      const committed = options.queue.complete(item, {
        source: "gateway/btcc/btcc-inbound-dispatcher.ts",
        dispatchStatus: result.status,
        terminalFailure: true,
        delivered: terminalDelivery,
      }, options.now?.());
      if (!committed) return summary;
      summary.handled = 1;
      summary.delivered = terminalDelivery;
      return summary;
    }

    const delivered = await deliverResult(item, result, options);
    const committed = options.queue.complete(item, {
      source: "gateway/btcc/btcc-inbound-dispatcher.ts",
      dispatchStatus: "handled",
      handled: true,
      delivered,
    }, options.now?.());
    if (!committed) return summary;
    summary.handled = 1;
    summary.delivered = delivered;
    return summary;
  } catch (error) {
    if (process.env.BUTLER_OPERATIONAL_DIAGNOSTICS === "1") {
      console.error(JSON.stringify({
        event: "btcc_inbound_dispatch_interrupted",
        name: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : String(error),
      }));
    }
    options.queue.parkForProcessReplacement(item, privateFailureMessage(error), {
      source: "gateway/btcc/btcc-inbound-dispatcher.ts",
      dispatchStatus: "runtime-interrupted",
    }, options.now?.());
    summary.interrupted = 1;
    return summary;
  }
}

async function deliverGatewayFailure(
  item: ClaimedInboundEvent,
  result: Exclude<GatewayDispatchResult, { status: "handled" }>,
  options: BtccInboundDispatchOptions,
): Promise<number | false | undefined> {
  if (item.envelope.transport !== "app") return undefined;
  const turnId = item.envelope.routingHints?.turnId?.trim();
  if (!turnId) return undefined;
  const safeErrorCode = result.status === "missing-handler"
    ? "gateway_missing_handler"
    : "gateway_unroutable";
  const action: OutboundAction = {
    actionId: `btcc-terminal-failure:${item.queueId}`,
    transport: "app",
    accountId: item.envelope.accountId,
    peer: {
      kind: "dm",
      id: item.envelope.peer.id,
    },
    message: {
      text: "Butler could not route this request to its execution session.",
      replyToMessageId: item.envelope.message.id,
    },
    metadata: {
      source: "gateway/btcc/btcc-inbound-dispatcher.ts",
      kind: "turn_failed",
      turnId,
      safeErrorCode,
      appQueueClaimId: item.envelope.routingHints?.appQueueClaimId,
      queueId: item.queueId,
      dispatchClaimId: item.processing.claimId,
    },
  };
  const deliver = options.deliverAction ??
    ((sessionId: string, outbound: OutboundAction, metadata: Record<string, unknown>) =>
      options.deliveryGuard.deliver(sessionId, outbound, metadata));
  const receipt = await deliver(
    item.envelope.routingHints?.sessionId ?? item.envelope.peer.id,
    action,
    { source: "gateway/btcc/btcc-inbound-dispatcher.ts", terminalFailure: true },
  );
  return receipt.ok ? 1 : false;
}

async function deliverResult(
  item: ClaimedInboundEvent,
  result: Extract<GatewayDispatchResult, { status: "handled" }>,
  options: BtccInboundDispatchOptions,
): Promise<number> {
  const actions = finalActions(item, result, options.store);
  const deliver = options.deliverAction ??
    ((sessionId: string, action: OutboundAction, metadata: Record<string, unknown>) =>
      options.deliveryGuard.deliver(sessionId, action, metadata));
  let delivered = 0;
  for (const action of actions) {
    const receipt = await deliver(result.route.sessionId, action, {
      source: "gateway/btcc/btcc-inbound-dispatcher.ts",
      queueId: item.queueId,
    });
    if (receipt.ok) delivered += 1;
  }
  return delivered;
}

function finalActions(
  item: ClaimedInboundEvent,
  result: Extract<GatewayDispatchResult, { status: "handled" }>,
  store: SessionBindingStore,
): OutboundAction[] {
  const controlAck = result.handlerResult.metadata?.controlAck;
  const binding = store.getBySessionId(result.route.sessionId);
  const targets = binding?.transportBindings ?? [];
  const actions: OutboundAction[] = [];
  if (controlAck && typeof controlAck === "object" && !Array.isArray(controlAck)) {
    actions.push(...controlAckActions({
      item,
      controlAck: controlAck as Record<string, unknown>,
      targets,
    }));
  }
  const terminalKind = optionalText(result.handlerResult.metadata?.kind);
  if (terminalKind === "turn_cancelled") {
    const terminalTargets = claimedAppTerminalTargets(item, targets);
    actions.push(...terminalTargets.map((target) => finalAction({
      item,
      target,
      text: "",
      artifacts: [],
      turnId: optionalText(result.handlerResult.metadata?.turnId) ??
        item.envelope.routingHints?.turnId,
      terminalKind,
      safeErrorCode: "turn_cancelled",
    })));
    return actions;
  }
  if (actions.length > 0) return actions;
  const text = result.handlerResult.metadata?.text;
  const artifacts = artifactRefs(result.handlerResult.metadata?.artifacts);
  const changedFiles = changedFilePaths(result.handlerResult.metadata?.changedFiles);
  const noVisibleReply = typeof text !== "string" ||
    (!text.trim() && artifacts.length === 0 && changedFiles.length === 0);
  const finalTargets = noVisibleReply
    ? claimedAppTerminalTargets(item, targets)
    : targets;
  if (noVisibleReply && finalTargets.length === 0) return actions;
  const generatedSessionTitle = optionalText(
    result.handlerResult.metadata?.generatedSessionTitle,
  );
  return finalTargets.map((target) => finalAction({
    item,
    target,
    text: typeof text === "string" ? text : "",
    artifacts,
    changedFiles,
    generatedSessionTitle,
    executionModel: result.handlerResult.metadata?.executionModel,
    canonicalMessageId: optionalText(result.handlerResult.metadata?.canonicalMessageId),
    turnId: optionalText(result.handlerResult.metadata?.turnId) ??
      item.envelope.routingHints?.turnId,
    noVisibleReply,
    safeErrorCode: noVisibleReply ? "no_visible_result" : undefined,
  }));
}

function claimedAppTerminalTargets(
  item: ClaimedInboundEvent,
  targets: SessionTransportBinding[],
): SessionTransportBinding[] {
  if (item.envelope.transport !== "app") return [];
  const claimId = item.envelope.routingHints?.appQueueClaimId;
  if (
    typeof claimId !== "string" ||
    !/^[\w:./-]{1,96}$/u.test(claimId.trim())
  ) return [];
  return targets.filter((target) => isMatchingClaimedAppTarget(item, target));
}

function finalAction(input: {
  item: ClaimedInboundEvent;
  target: SessionTransportBinding;
  text: string;
  artifacts: ArtifactRef[];
  changedFiles?: ChangedFileDetail[];
  generatedSessionTitle?: string;
  canonicalMessageId?: string;
  turnId?: string;
  executionModel?: unknown;
  terminalKind?: string;
  noVisibleReply?: boolean;
  safeErrorCode?: string;
}): OutboundAction {
  const { item, target } = input;
  const appClaimBinding = isMatchingClaimedAppTarget(item, target)
    ? {
        appQueueClaimId: item.envelope.routingHints?.appQueueClaimId,
        appQueueClaimProvenance: "matching_app_target",
      }
    : {};
  return {
    actionId: `btcc-final:${input.canonicalMessageId ?? item.queueId}:${target.transport}:${target.peerId}:${target.threadId ?? "main"}`,
    transport: target.transport,
    accountId: target.accountId,
    peer: {
      kind: target.threadId ? "thread" : target.transport === "app" ? "dm" : "group",
      id: target.peerId,
      threadId: target.threadId,
    },
    message: {
      text: input.text,
      artifacts: input.artifacts.length > 0 ? input.artifacts : undefined,
      changedFiles: input.changedFiles?.length ? input.changedFiles : undefined,
      replyToMessageId: item.envelope.message.id,
    },
    metadata: {
      source: "gateway/btcc/btcc-inbound-dispatcher.ts",
      kind: input.terminalKind ?? "final_result",
      queueId: item.queueId,
      dispatchClaimId: item.processing.claimId,
      ...appClaimBinding,
      ...(input.noVisibleReply ? { noVisibleReply: true } : {}),
      ...(input.safeErrorCode ? { safeErrorCode: input.safeErrorCode } : {}),
      turnId: input.turnId,
      canonicalMessageId: input.canonicalMessageId,
      generatedSessionTitle: input.generatedSessionTitle,
      ...(input.executionModel ? { executionModel: input.executionModel } : {}),
    },
  };
}

function changedFilePaths(value: unknown): ChangedFileDetail[] {
  if (!Array.isArray(value)) return [];
  return value.filter((detail): detail is ChangedFileDetail =>
    Boolean(detail && typeof detail === "object" && !Array.isArray(detail) &&
      typeof (detail as Record<string, unknown>).path === "string" &&
      Array.isArray((detail as Record<string, unknown>).lines)),
  ).slice(0, 40);
}

function artifactRefs(value: unknown): ArtifactRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index): ArtifactRef[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const item = candidate as Record<string, unknown>;
    const title = optionalText(item.title) ?? `Artifact ${index + 1}`;
    return [{
      id: optionalText(item.id) ?? `artifact-${index + 1}`,
      kind: artifactKind(item.kind),
      title,
      safePathLabel: optionalText(item.safePathLabel),
      mimeType: optionalText(item.mimeType),
      url: optionalText(item.url),
      sizeBytes: typeof item.sizeBytes === "number" ? item.sizeBytes : undefined,
      createdAt: optionalText(item.createdAt),
    }];
  }).slice(0, 12);
}

function artifactKind(value: unknown): ArtifactRef["kind"] {
  const kinds: ArtifactRef["kind"][] = [
    "csv_file", "table_file", "chart_file", "image", "document",
    "code", "report", "file",
  ];
  return kinds.includes(value as ArtifactRef["kind"])
    ? value as ArtifactRef["kind"]
    : "unknown";
}

function reactivateSession(
  item: ClaimedInboundEvent,
  store: SessionBindingStore,
  now?: Date,
): void {
  const sessionId = item.envelope.routingHints?.sessionId?.trim();
  if (!sessionId) return;
  const binding = store.getBySessionId(sessionId);
  if (!binding || binding.lifecycleState === "active" || binding.lifecycleState === "closing") {
    return;
  }
  store.updateLifecycleState(sessionId, "active", now?.toISOString());
}

function claimableSession(
  event: QueuedInboundEvent,
  active: Set<string>,
  batch: Set<string>,
): boolean {
  const key = sessionKeyFor(event);
  if (active.has(key) || batch.has(key)) return false;
  batch.add(key);
  return true;
}

function sessionKeyFor(event: QueuedInboundEvent): string {
  const base = event.envelope.routingHints?.sessionId?.trim() || [
    event.envelope.transport,
    event.envelope.accountId,
    event.envelope.peer.kind,
    event.envelope.peer.id,
  ].join(":");
  return event.envelope.control?.kind === "cancel_turn"
    ? `${base}:cancel:${event.envelope.control.requestId}`
    : base;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function privateFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "BTCC runtime interruption";
}

function emptySummary(): BtccInboundDispatchSummary {
  return { claimed: 0, handled: 0, delivered: 0, failed: 0, interrupted: 0 };
}

function addSummary(
  target: BtccInboundDispatchSummary,
  source: BtccInboundDispatchSummary,
): void {
  target.handled += source.handled;
  target.delivered += source.delivered;
  target.failed += source.failed;
  target.interrupted += source.interrupted;
}
