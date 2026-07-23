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
  const diagnostic = diagnosticMessage(interruption);
  return {
    kind: "previous_provider_product_rejected",
    code: interruption.code,
    ...(diagnostic ? { diagnosticMessage: diagnostic } : {}),
  };
}

function diagnosticMessage(interruption: OperationalInterruptionError): string | undefined {
  return interruption.cause instanceof Error ? interruption.cause.message : undefined;
}
