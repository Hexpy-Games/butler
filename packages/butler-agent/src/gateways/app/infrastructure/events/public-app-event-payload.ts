import {
  isPublicSuppressedInternalContinuationCode,
  publicTurnPayloadRecord,
  publicTurnStatusLabel,
} from "../transport/btcc-public-projection.ts";
import {
  isRecord,
  safeOptionalShortText,
  safeOptionalShortToken,
} from "../core/projection-safe-values.ts";

export function publicAppEventPayload(
  type: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (type === "agent.turn_event") return publicAgentTurnEventPayload(payload);
  if (type !== "turn.state_changed") return payload;
  const turn = isRecord(payload.turn) ? payload.turn : null;
  const state = safeOptionalShortToken(payload.state) ??
    safeOptionalShortToken(turn?.state);
  const safeErrorCode = safeOptionalShortToken(
    payload.safe_error_code ?? turn?.safe_error_code,
  );
  const label = publicTurnStatusLabel(
    safeOptionalShortText(payload.safe_status_label ?? turn?.safe_status_label),
    state,
    safeErrorCode,
  );
  const nextPayload: Record<string, unknown> = { ...payload };
  if (isPublicSuppressedInternalContinuationCode(safeErrorCode)) {
    delete nextPayload.safe_error_code;
    nextPayload.retryable = false;
  }
  if (label) nextPayload.safe_status_label = label;
  else delete nextPayload.safe_status_label;
  if (turn) {
    nextPayload.turn = publicTurnPayloadRecord(turn);
  }
  return nextPayload;
}

function publicAgentTurnEventPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const event = isRecord(payload.event) ? payload.event : null;
  const eventPayload = event && isRecord(event.payload) ? event.payload : null;
  if (!eventPayload || !("operatorSummary" in eventPayload)) return payload;
  const nextEventPayload = { ...eventPayload };
  delete nextEventPayload.operatorSummary;
  return {
    ...payload,
    event: {
      ...event,
      payload: nextEventPayload,
    },
  };
}
