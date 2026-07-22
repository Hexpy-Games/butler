import type { PhaseRunBinding } from "./contracts.ts";

/**
 * Model-authored request IDs are local to one persisted provider round.
 * The pending round revision is stable across crash recovery and changes before
 * a later model round may reuse the same local ID.
 */
export function operationRoundScope(binding: PhaseRunBinding): string {
  return `${binding.checkpointId}:${binding.checkpointRevision}`;
}
