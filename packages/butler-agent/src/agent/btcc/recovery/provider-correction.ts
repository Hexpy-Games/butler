import type { ProviderCorrection } from "../core/index.ts";
import type { OperationalInterruptionError } from "./operational-interruption.ts";

export function correctionForOperationalInterruption(
  interruption: OperationalInterruptionError | null,
): ProviderCorrection | undefined {
  if (
    interruption?.code !== "provider_protocol_interruption" &&
    interruption?.code !== "provider_phase_submission_invalid"
  ) {
    return undefined;
  }
  return {
    kind: "previous_provider_product_rejected",
    code: interruption.code,
  };
}
