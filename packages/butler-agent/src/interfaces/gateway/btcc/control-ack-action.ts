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
      ...input.controlAck,
      source: "gateway/btcc/btcc-inbound-dispatcher.ts",
      kind: "turn_cancellation_ack",
      queueId: input.item.queueId,
      dispatchClaimId: input.item.processing.claimId,
    },
  }));
}
