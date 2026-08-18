import type {
  OutboundAction,
  SessionTransportBinding,
} from "../../../test-support/harness/contracts.ts";
import type { ClaimedInboundEvent } from
  "../../../gateways/core/inbound-queue.ts";

export function controlAckActions(input: {
  item: ClaimedInboundEvent;
  controlAck: Record<string, unknown>;
  targets: SessionTransportBinding[];
}): OutboundAction[] {
  const {
    appQueueClaimId: _ignoredClaimId,
    appQueueClaimProvenance: _ignoredClaimProvenance,
    ...safeControlAck
  } = input.controlAck;
  return input.targets.map((target) => ({
    actionId: `btcc-control-ack:${input.item.envelope.eventId}:${target.transport}:${target.peerId}:${target.threadId ?? "main"}`,
    transport: target.transport,
    accountId: target.accountId,
    peer: {
      kind: target.threadId ? "thread" : target.transport === "app" ? "dm" : "group",
      id: target.peerId,
      threadId: target.threadId,
    },
    message: { replyToMessageId: input.item.envelope.message.id },
    metadata: {
      ...safeControlAck,
      source: "gateway/btcc/btcc-inbound-dispatcher.ts",
      kind: "turn_cancellation_ack",
      queueId: input.item.queueId,
      dispatchClaimId: input.item.processing.claimId,
      ...(isMatchingClaimedAppTarget(input.item, target)
        ? {
            appQueueClaimId: input.item.envelope.routingHints?.appQueueClaimId,
            appQueueClaimProvenance: "matching_app_target",
          }
        : {}),
    },
  }));
}

export function isMatchingClaimedAppTarget(
  item: ClaimedInboundEvent,
  target: SessionTransportBinding,
): boolean {
  if (item.envelope.transport !== "app" || target.transport !== "app") return false;
  const claimId = item.envelope.routingHints?.appQueueClaimId;
  if (
    typeof claimId !== "string" ||
    !/^[\w:./-]{1,96}$/u.test(claimId.trim())
  ) return false;
  return target.accountId === item.envelope.accountId &&
    target.peerId === item.envelope.peer.id &&
    (target.threadId ?? "") === (item.envelope.peer.parentId ?? "");
}
