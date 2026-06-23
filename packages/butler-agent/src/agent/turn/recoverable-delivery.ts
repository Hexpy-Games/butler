import { safeRuntimeFailure } from "../../integrations/providers/provider-errors.ts";
import { INTERNAL_RECOVERY_REQUIRED_CODE } from "../../runtime/internal-recovery-failure.ts";
import {
  classifyRuntimeFailureDelivery,
  deliveredWithLimitationsState,
  safeLimitationText,
  type RuntimeDeliveryClassification,
} from "./runtime-delivery-state.ts";

const DEFAULT_LIMITED_DELIVERY_REASON =
  "Butler could not verify that the requested goal was completed with the available evidence.";

export interface RecoverableLimitedDelivery {
  text: string;
  reason: string;
  delivery: RuntimeDeliveryClassification;
}

export function recoverableLimitedDeliveryForError(error: unknown): RecoverableLimitedDelivery | null {
  const classified = classifyRuntimeFailureDelivery(error);
  if (classified.issue_kind !== "internal_recovery") return null;
  const failure = safeRuntimeFailure(error);
  const reason = safeLimitationText(
    failure.message,
    DEFAULT_LIMITED_DELIVERY_REASON,
  );
  const text = reason === "Butler could not verify that the requested goal was completed."
    ? DEFAULT_LIMITED_DELIVERY_REASON
    : reason;
  return {
    text,
    reason: text,
    delivery: deliveredWithLimitationsState({
      limitationCodes: [classified.limitation_codes[0] ?? failure.code ?? INTERNAL_RECOVERY_REQUIRED_CODE],
      limitations: [text],
    }),
  };
}
