import type { StewardObserverReader } from "../../../packages/butler-agent/src/gateways/app/domain/sessions/steward-observer.ts";

/** Test-only composition for App/retention tests that do not seed BTCC relations. */
export const EMPTY_STEWARD_OBSERVER: StewardObserverReader = {
  workStatus: () => ({
    items: [],
    counts: {
      running: 0,
      completed: 0,
      attention: 0,
      operational_action: 0,
      operational_interruption: 0,
    },
  }),
  relationsForParent: () => [],
  relationById: () => null,
  relationForChild: () => null,
  delegationPresentation: () => null,
  isParentResultInput: () => false,
  snapshot: () => null,
  recoverableTurns: () => [],
  readOperationOutputChunks: () => [],
};
