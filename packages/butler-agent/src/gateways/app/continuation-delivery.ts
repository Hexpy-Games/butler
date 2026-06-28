import type { TurnState, SessionViewTurnDeliveryState } from "./protocol.ts";

export type ContinuationDeliveryState = Extract<
  SessionViewTurnDeliveryState,
  | "recovering_internal"
  | "needs_tool_surface"
  | "needs_evidence"
  | "needs_argument_repair"
>;

export interface ContinuationLimitedDeliveryShape {
  delivery_state: ContinuationDeliveryState;
  terminal: false;
  issue_kind:
    | "tool_call_repair"
    | "completion_continuation"
    | "runtime_continuation";
  visibility: "tool_retry_progress" | "continuation_progress";
  failure_notice: false;
  limitation_codes: string[];
  limitations: [];
}

export interface ContinuationTurnState {
  state: TurnState;
}

export function continuationDeliveryFromState(
  deliveryState: ContinuationDeliveryState,
  limitationCodes: string[],
): ContinuationLimitedDeliveryShape {
  const toolRepair =
    deliveryState === "needs_tool_surface" ||
    deliveryState === "needs_argument_repair";
  return {
    delivery_state: deliveryState,
    terminal: false,
    issue_kind: toolRepair
      ? "tool_call_repair"
      : deliveryState === "needs_evidence"
        ? "completion_continuation"
        : "runtime_continuation",
    visibility: toolRepair ? "tool_retry_progress" : "continuation_progress",
    failure_notice: false,
    limitation_codes: limitationCodes,
    limitations: [],
  };
}

export function shouldAutomaticallyRequeueContinuation(
  turn: ContinuationTurnState | null,
  deliveryState: SessionViewTurnDeliveryState,
): boolean {
  return Boolean(
    turn &&
      !isInternalContinuationTurnState(turn.state) &&
      isContinuationDeliveryState(deliveryState),
  );
}

export function isContinuationDeliveryState(
  deliveryState: SessionViewTurnDeliveryState | null,
): deliveryState is ContinuationDeliveryState {
  return (
    deliveryState === "recovering_internal" ||
    deliveryState === "needs_tool_surface" ||
    deliveryState === "needs_evidence" ||
    deliveryState === "needs_argument_repair"
  );
}

export function isContinuationDeliveryIssue(issueKind: string): boolean {
  return issueKind === "internal_recovery" ||
    issueKind === "tool_call_repair" ||
    issueKind === "completion_continuation" ||
    issueKind === "runtime_continuation";
}

function isInternalContinuationTurnState(state: TurnState): boolean {
  return state === "retrying" || state === "waiting_for_tool";
}
