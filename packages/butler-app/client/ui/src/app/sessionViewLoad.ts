import { create } from "zustand";

/**
 * The session whose session-view load has finished, whether it succeeded or
 * failed. A failed load leaves the summary empty, so readers waiting for the
 * summary stop waiting once the load has settled.
 */
export const useSessionViewLoad = create<{ settled: string | null }>(() => ({ settled: null }));

export function startSessionViewLoad(): void {
  useSessionViewLoad.setState({ settled: null });
}

export function settleSessionViewLoad(sessionId: string): void {
  useSessionViewLoad.setState({ settled: sessionId });
}
