import type { BtccAgentLoopResult } from "../agent-loop/index.ts";
import { contentRef, digest } from "../identity/index.ts";
import type { TurnRecord } from "./contracts.ts";
import { operationalFailureMessage } from "./turn-runtime-failure.ts";

export function guidedFinalTransition(
  turn: TurnRecord,
  result: BtccAgentLoopResult,
) {
  const content = result.terminalOutcome === "no_visible"
    ? ""
    : result.content.trim() || operationalFailureMessage(turn.originalMessage);
  const finalPayloadBody = {
    turnId: turn.turnId,
    contentSha256: digest(content),
    route: result.route,
    disposition: "completed" as const,
    content,
    ...(result.artifacts?.length ? { artifacts: result.artifacts } : {}),
    ...(result.modelIdentity ? { modelIdentity: result.modelIdentity } : {}),
  };
  const finalPayload = {
    ref: contentRef("payload", finalPayloadBody),
    ...finalPayloadBody,
  };
  const committedRevision = turn.revision + 1;
  const outboxId = digest(
    `btcc-canonical-delivery.v1\0${turn.turnId}\0${committedRevision}\0${finalPayload.ref.sha256}`,
  );
  return {
    kind: "accept_guided_final" as const,
    successor: "delivery_committed" as const,
    successorCheckpointKind: "runtime" as const,
    route: result.route,
    finalPayload,
    deliveryOutbox: {
      outboxId,
      finalPayloadRef: finalPayload.ref,
      expectedMessageId: digest(`btcc-assistant-message.v1\0${outboxId}`),
      content,
      status: "pending" as const,
    },
  };
}
