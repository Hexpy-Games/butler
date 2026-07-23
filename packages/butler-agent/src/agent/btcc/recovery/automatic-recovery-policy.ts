import type { OperationalInterruptionError } from "./operational-interruption.ts";

export function shouldScheduleAutomaticRecovery(
  interruption: OperationalInterruptionError,
): boolean {
  return interruption.activation.kind === "automatic_provider_recovery" ||
    interruption.activation.kind === "automatic_storage_recovery";
}
