import { deliveredWithLimitationsState } from "../../agent/turn/runtime-delivery-state.ts";
import { INTERNAL_RECOVERY_REQUIRED_CODE } from "../../runtime/internal-recovery-failure.ts";
import type { ProjectedSafeTurnFailure } from "./turn-failure-projection.ts";
import {
  appLimitedDeliveryForError,
  type AppLimitedDelivery,
} from "./failure-ux-contract.ts";
import {
  continuationDeliveryFromState,
  isContinuationDeliveryState,
} from "./continuation-delivery.ts";
import {
  isPublicSuppressedInternalContinuationCode,
  type AppProjectionDeliveryState,
} from "./btcc-public-projection.ts";
import {
  isRecord,
  safeOptionalShortToken,
  safeShortTextList,
  safeShortTokenList,
} from "./projection-safe-values.ts";

export interface DeliveryLimitationMetadata {
  delivery_state: AppProjectionDeliveryState;
  limitation_codes: string[];
  limitations: string[];
}

export function deliveryLimitationMetadataFromRecord(
  record: Record<string, unknown>,
  options: { noVisibleReply?: boolean } = {},
): DeliveryLimitationMetadata | null {
  const deliveryState = safeDeliveryState(
    record.delivery_state ?? record.deliveryState,
  );
  if (
    deliveryState !== "delivered_with_limitations" &&
    !isContinuationDeliveryState(deliveryState)
  ) {
    return null;
  }
  return {
    delivery_state: deliveryState,
    limitation_codes: safeShortTokenList(
      record.limitation_codes ?? record.limitationCodes,
    ),
    limitations: options.noVisibleReply ? [] : safeShortTextList(record.limitations),
  };
}

export function hasUnsupportedNoVisibleDeliveryState(
  metadata: Record<string, unknown>,
  delivery: DeliveryLimitationMetadata | null,
): boolean {
  const deliveryState = safeDeliveryState(
    metadata.delivery_state ?? metadata.deliveryState,
  );
  return Boolean(deliveryState && !delivery);
}

export function deliveryStateFromProjectedNoVisibleFinal(
  delivery: DeliveryLimitationMetadata | null,
): AppLimitedDelivery["delivery"] {
  const limitationCodes = delivery?.limitation_codes.length
    ? delivery.limitation_codes
    : [INTERNAL_RECOVERY_REQUIRED_CODE];
  if (delivery && isContinuationDeliveryState(delivery.delivery_state)) {
    return continuationDeliveryFromState(delivery.delivery_state, limitationCodes);
  }
  return deliveredWithLimitationsState({
    limitationCodes,
    limitations: [],
  });
}

export function appLimitedDeliveryForProjectedFailure(
  safeError: ProjectedSafeTurnFailure,
): AppLimitedDelivery | null {
  const classified = appLimitedDeliveryForError({
    name: "AppTransportTurnFailure",
    code: safeError.code,
    message: safeError.message,
  });
  if (classified) return classified;
  if (
    safeError.code !== INTERNAL_RECOVERY_REQUIRED_CODE &&
    safeError.code !== "prompt_usage_model_call_budget_exhausted"
  ) {
    return null;
  }
  return {
    text: null,
    reason: "Internal continuation required.",
    delivery: continuationDeliveryFromState("needs_evidence", [safeError.code]),
  };
}

export function shouldTreatLimitedFinalAsNoVisible(
  artifacts: unknown[],
  delivery: DeliveryLimitationMetadata | null,
  metadata: Record<string, unknown>,
): boolean {
  if (metadata.visibleLimitedReply === true) return false;
  if (artifacts.length > 0 || !delivery) return false;
  return delivery.limitation_codes.some((code) =>
    isPublicSuppressedInternalContinuationCode(code),
  );
}

export function shouldProjectRecoverableLimitedFinalOverTerminalTurn(
  turn: { state: string; safe_error_code: string | null },
  metadata: Record<string, unknown>,
): boolean {
  if (turn.state !== "failed") return false;
  const kind = safeOptionalShortToken(metadata.kind);
  if (kind !== "final_result") return false;
  const delivery = deliveryLimitationMetadataFromRecord(metadata);
  if (!delivery) return false;
  const priorCode = safeOptionalShortToken(turn.safe_error_code);
  if (
    priorCode !== "inbound_dispatch_timeout" &&
    priorCode !== "internal_recovery_required"
  ) {
    return false;
  }
  return delivery.limitation_codes.some((code) =>
    code === "internal_recovery_required" ||
    code === "prompt_usage_model_call_budget_exhausted",
  );
}

export function shouldAcceptRecoverableLimitedFinalForFailedQueue(
  metadata: Record<string, unknown>,
  failedRecord: Record<string, unknown>,
  dispatchClaimId: string,
): boolean {
  const failedClaimId = terminalClaimId(failedRecord);
  if (!failedClaimId || failedClaimId !== dispatchClaimId) return false;
  const failure = isRecord(failedRecord.metadata)
    ? failedRecord.metadata.failure
    : null;
  const failureCode = isRecord(failure)
    ? safeOptionalShortToken(failure.code)
    : undefined;
  if (
    failureCode !== "inbound_dispatch_timeout" &&
    failureCode !== "internal_recovery_required"
  ) {
    return false;
  }
  const delivery = deliveryLimitationMetadataFromRecord(metadata);
  return Boolean(delivery?.limitation_codes.some((code) =>
    code === "internal_recovery_required" ||
    code === "prompt_usage_model_call_budget_exhausted",
  ));
}

export function terminalClaimId(
  record: Record<string, unknown> | null,
): string | undefined {
  const metadata = isRecord(record?.metadata) ? record.metadata : {};
  return safeOptionalShortToken(metadata.terminalClaimId);
}

function safeDeliveryState(value: unknown): AppProjectionDeliveryState | null {
  if (typeof value !== "string") return null;
  if (
    value === "running" ||
    value === "recovering_internal" ||
    value === "needs_tool_surface" ||
    value === "needs_evidence" ||
    value === "needs_argument_repair" ||
    value === "waiting_user" ||
    value === "system_error" ||
    value === "cancelled" ||
    value === "delivered" ||
    value === "delivered_with_limitations" ||
    value === "failed_system"
  ) {
    return value;
  }
  return null;
}
