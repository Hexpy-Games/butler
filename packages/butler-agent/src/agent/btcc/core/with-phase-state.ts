import type { PhaseInvocation } from "./contracts.ts";

export function withPhaseState(
  phase: PhaseInvocation,
  stateInput: unknown,
): PhaseInvocation {
  return {
    ...phase,
    context: { ...phase.context, stateInput },
  };
}
