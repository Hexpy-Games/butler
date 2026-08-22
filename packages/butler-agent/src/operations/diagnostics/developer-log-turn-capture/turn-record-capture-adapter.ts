import type { InboundEnvelope } from "../../../gateways/core/contracts.ts";
import type { StoredSessionBinding } from "../../../test-support/harness/contracts.ts";
import type { TurnRecord } from "../../../agent/btcc/turn/index.ts";

export const BTCC_TURN_RUNTIME_ADAPTER_ID = "btcc-turn-runtime";

/** Transport label for Turns admitted without a routed progress destination. */
const UNROUTED_TRANSPORT = "unrouted";

/**
 * Adapts a durable BTCC Turn record into the session-binding identity that
 * DeveloperLogStore expects; fields the new lifecycle does not carry are
 * neutral placeholders the store never persists.
 */
export function storedBindingFromTurnRecord(
  turn: TurnRecord,
  observedAt: string,
): StoredSessionBinding {
  const executionPolicy = turn.context.executionPolicy;
  return {
    sessionId: turn.sessionId,
    role: executionPolicy?.role === "steward" ? "steward" : "butler",
    ...(turn.context.projectRef ? { projectId: turn.context.projectRef } : {}),
    workspacePath: executionPolicy?.workspacePath ?? "",
    runtimeAdapterId: BTCC_TURN_RUNTIME_ADAPTER_ID,
    modelProviderId: turn.modelSelection.provider,
    modelRef: `${turn.modelSelection.provider}/${turn.modelSelection.model}`,
    transportBindings: [],
    lifecycleState: "active",
    createdAt: observedAt,
    updatedAt: observedAt,
  };
}

/** Builds the minimal inbound-envelope view of an admitted Turn record. */
export function inboundEnvelopeFromTurnRecord(
  turn: TurnRecord,
  observedAt: string,
): InboundEnvelope {
  const destination = turn.progressDestination;
  return {
    eventId: `${UNROUTED_TRANSPORT}:${turn.originalMessageId}`,
    transport: destination?.transport ?? UNROUTED_TRANSPORT,
    accountId: destination?.accountId ?? "",
    peer: destination
      ? { ...destination.peer }
      : { kind: "dm", id: turn.sessionId },
    sender: { id: BTCC_TURN_RUNTIME_ADAPTER_ID },
    message: {
      id: turn.originalMessageId,
      text: turn.originalMessage,
      timestamp: observedAt,
    },
    routingHints: {
      sessionId: turn.sessionId,
      turnId: turn.turnId,
    },
  };
}
