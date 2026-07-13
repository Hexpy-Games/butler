import type {
  SessionViewTurnDeliveryState,
  TurnRecord,
  TurnState,
} from "../../interface/protocol/app-protocol.ts";
import { INTERNAL_RECOVERY_REQUIRED_CODE } from "../../../../runtime/internal-recovery-failure.ts";

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

export const APP_TURN_QUEUE_FAILED_CODE = "app_turn_queue_failed";
export const GOAL_COMPLETION_INCOMPLETE_CODE = "goal_completion_incomplete";
export const COMPLETION_REVIEW_INCOMPLETE_CODE = "completion_review_incomplete";
export const PROMPT_USAGE_MODEL_CALL_BUDGET_EXHAUSTED_CODE =
  "prompt_usage_model_call_budget_exhausted";

export const HIDDEN_LEGACY_ASSISTANT_SAFE_ERROR_CODES = [
  APP_TURN_QUEUE_FAILED_CODE,
  GOAL_COMPLETION_INCOMPLETE_CODE,
] as const;

export const INTERNAL_CONTINUATION_PUBLIC_SUPPRESSED_SAFE_ERROR_CODES = [
  INTERNAL_RECOVERY_REQUIRED_CODE,
  GOAL_COMPLETION_INCOMPLETE_CODE,
  APP_TURN_QUEUE_FAILED_CODE,
  COMPLETION_REVIEW_INCOMPLETE_CODE,
] as const;

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
    state === "delivered_with_continuation" ||
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

export function publicTurnStatusLabel(
  label: string | null | undefined,
  state: string | null | undefined,
  safeErrorCode?: string | null,
): string | undefined {
  const trimmed = label?.trim();
  if (!trimmed) return undefined;
  if (isPublicSuppressedInternalContinuationCode(safeErrorCode)) {
    return undefined;
  }
  return state && isInternalContinuationTurnState(state) ? undefined : trimmed;
}

export function isPublicSuppressedInternalContinuationCode(
  safeErrorCode: string | null | undefined,
): boolean {
  return INTERNAL_CONTINUATION_PUBLIC_SUPPRESSED_SAFE_ERROR_CODES.includes(
    safeErrorCode as (typeof INTERNAL_CONTINUATION_PUBLIC_SUPPRESSED_SAFE_ERROR_CODES)[number],
  );
}

export function publicTurnRecord(turn: TurnRecord): TurnRecord {
  if (!isPublicSuppressedInternalContinuationCode(turn.safe_error_code)) {
    return turn;
  }
  const { safe_error_code: _safeErrorCode, ...withoutSafeErrorCode } = turn;
  return {
    ...withoutSafeErrorCode,
    safe_status_label: "",
    retryable: false,
  };
}

export function publicTurnPayloadRecord(
  turn: Record<string, unknown>,
): Record<string, unknown> {
  const safeErrorCode = safeOptionalShortToken(turn.safe_error_code);
  if (!isPublicSuppressedInternalContinuationCode(safeErrorCode)) {
    const label = publicTurnStatusLabel(
      safeOptionalShortText(turn.safe_status_label),
      safeOptionalShortToken(turn.state),
      safeErrorCode,
    );
    const nextTurn = { ...turn };
    if (label) nextTurn.safe_status_label = label;
    else delete nextTurn.safe_status_label;
    return nextTurn;
  }
  const nextTurn = { ...turn };
  delete nextTurn.safe_error_code;
  delete nextTurn.safe_status_label;
  nextTurn.retryable = false;
  return nextTurn;
}

export function publicAppDeliveryMetadata(
  delivery: PublicDeliveryMetadata,
): PublicDeliveryMetadata {
  const limitation_codes = delivery.limitation_codes.filter(
    (code) => !isPublicSuppressedInternalContinuationCode(code),
  );
  const limitations = delivery.limitations.filter((_, index) => {
    const code = delivery.limitation_codes[index];
    return !isPublicSuppressedInternalContinuationCode(code);
  });
  return {
    ...delivery,
    limitation_codes,
    limitations,
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

function isInternalContinuationTurnState(state: string): boolean {
  return state === "retrying" || state === "waiting_for_tool";
}

function safeOptionalShortToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return undefined;
  return /^[a-z0-9_.:-]+$/iu.test(trimmed) ? trimmed : undefined;
}

function safeOptionalShortText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 240);
}
