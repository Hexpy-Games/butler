import type { StewardObserverReader } from "../../../packages/butler-agent/src/gateways/app/domain/sessions/steward-observer.ts";

/** Test-only composition for App/retention tests that do not seed BTCC relations. */
export const EMPTY_STEWARD_OBSERVER: StewardObserverReader = {
  relationsForParent: () => [],
  relationById: () => null,
  relationForChild: () => null,
  isParentResultInput: () => false,
  snapshot: () => null,
  recoverableTurns: () => [],
  readOperationOutputChunks: () => [],
};
