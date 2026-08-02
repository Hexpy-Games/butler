import {
  createTurnRuntime,
  type TurnRuntimeDependencies,
} from "../turn/turn.ts";

/**
 * Compatibility name for focused legacy unit fixtures.
 * Product composition uses `agent/btcc/turn/turn.ts` directly.
 */
export type GuidedTurnRuntimeDependencies = TurnRuntimeDependencies;

export function createGuidedTurnRuntime(
  dependencies: GuidedTurnRuntimeDependencies,
) {
  return createTurnRuntime(dependencies);
}
