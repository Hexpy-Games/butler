import { create } from "zustand";

/** Pointer drag state is transient and never changes the sidebar's row organization. */
export const useBrowserTabDrag = create<{
  tabId?: string; owner?: string; target?: { session: string; instance: string; title: string };
  outside: boolean; edge: "start" | "end" | null;
}>(() => ({ outside: false, edge: null }));
export const endBrowserTabDrag = () => useBrowserTabDrag.setState({ tabId: undefined, owner: undefined, target: undefined, outside: false, edge: null });
