import type {
  SessionViewTurnDeliveryState,
  TurnState,
} from "./protocol.ts";

export type InternalContinuationDeliveryState =
  | "recovering_internal"
  | "needs_tool_surface"
  | "needs_evidence"
  | "needs_argument_repair";

export type AppProjectionDeliveryState =
  | SessionViewTurnDeliveryState
  | InternalContinuationDeliveryState;

export interface AppProjectionDeliveryMetadata {
  delivery_state: AppProjectionDeliveryState;
  limitation_codes: string[];
  limitations: string[];
}

export interface PublicDeliveryMetadata {
  delivery_state: SessionViewTurnDeliveryState;
  limitation_codes: string[];
  limitations: string[];
}

export function publicDeliveryStateForTurnState(
  state: TurnState,
): SessionViewTurnDeliveryState {
  if (state === "delivered") return "delivered";
  if (state === "failed" || state === "runtime_fault") return "failed_system";
  if (state === "cancelled") return "cancelled";
  if (state === "waiting_for_form") return "waiting_user";
  return "running";
}

export function publicDeliveryStateForProjection(
  state: unknown,
): SessionViewTurnDeliveryState {
  if (isInternalContinuationDeliveryState(state)) return "running";
  if (
    state === "running" ||
    state === "waiting_user" ||
    state === "system_error" ||
    state === "cancelled" ||
    state === "delivered" ||
    state === "delivered_with_limitations" ||
    state === "failed_system"
  ) {
    return state;
  }
  if (state === "runtime_fault") return "failed_system";
  return "failed_system";
}

export function publicDeliveryMetadataForProjection(
  metadata: AppProjectionDeliveryMetadata,
): PublicDeliveryMetadata {
  if (isInternalContinuationDeliveryState(metadata.delivery_state)) {
    return {
      delivery_state: "running",
      limitation_codes: [],
      limitations: [],
    };
  }
  return {
    delivery_state: metadata.delivery_state,
    limitation_codes: metadata.limitation_codes,
    limitations: metadata.limitations,
  };
}

export function isInternalContinuationDeliveryState(
  state: unknown,
): state is InternalContinuationDeliveryState {
  return (
    state === "recovering_internal" ||
    state === "needs_tool_surface" ||
    state === "needs_evidence" ||
    state === "needs_argument_repair"
  );
}
