import { safeRuntimeFailure } from "../../integrations/providers/provider-errors.ts";
import {
  classifyRuntimeFailureDelivery,
  deliveredWithLimitationsState,
  safeLimitationText,
  type RuntimeDeliveryClassification,
} from "./runtime-delivery-state.ts";

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
    "Butler could not verify that the requested goal was completed with the available evidence.",
  );
  return {
    text: reason,
    reason,
    delivery: deliveredWithLimitationsState({
      limitationCodes: [classified.limitation_codes[0] ?? failure.code ?? "internal_recovery_required"],
      limitations: [reason],
    }),
  };
}
