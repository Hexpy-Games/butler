export {
  applyLiveNavigationEvent,
  isNavigationEvent,
  isProjectNavigationEvent,
} from "./liveNavigationProjection.ts";

export interface NavigationRefreshOptions {
  isCurrent?: () => boolean;
}

export interface LiveNavigationStore {
  getState: () => {
    refreshNavigation: (options?: NavigationRefreshOptions) => Promise<unknown>;
  };
}

export interface LiveNavigationReconciliation {
  noteLiveEvent(): void;
  noteLiveNavigationEvent(): void;
  requestRefresh(): void;
  dispose(): void;
}
export function createLiveNavigationReconciliation(
  store: LiveNavigationStore,
): LiveNavigationReconciliation {
  let disposed = false;
  let inFlight = false;
  let dirty = false;
  let retryPending = false;
  let generation = 0;

  const startRefresh = () => {
    if (disposed || inFlight || !dirty) return;
    inFlight = true;
    dirty = false;
    const requestGeneration = generation;
    const isCurrent = () => !disposed && requestGeneration === generation;
    Promise.resolve()
      .then(() => store.getState().refreshNavigation({ isCurrent }))
      .then(
        (accepted) => {
          retryPending = accepted === false;
        },
        () => {
          retryPending = true;
        },
      )
      .finally(() => {
        inFlight = false;
        if (disposed) return;
        if (dirty) startRefresh();
      });
  };

  return {
    noteLiveEvent() {
      if (!inFlight && retryPending) {
        dirty = true;
        startRefresh();
      }
    },
    noteLiveNavigationEvent() {
      generation += 1;
      if (inFlight) {
        dirty = true;
      } else if (retryPending) {
        dirty = true;
        startRefresh();
      }
    },
    requestRefresh() {
      if (disposed) return;
      dirty = true;
      startRefresh();
    },
    dispose() {
      disposed = true;
      generation += 1;
      dirty = false;
    },
  };
}
