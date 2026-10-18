import { create } from "zustand";

/** Pointer drag state is transient and never changes the sidebar's row organization. */
export const useBrowserTabDrag = create<{
  tabId?: string; owner?: string; target?: { session: string; instance: string; title: string };
  outside: boolean; edge: "start" | "end" | null;
  /** The pointer and the dragged tab's face, for the lifted tab outside the strip. */
  x?: number; y?: number; title?: string; favicon?: string;
}>(() => ({ outside: false, edge: null }));
export const endBrowserTabDrag = () => useBrowserTabDrag.setState({
  tabId: undefined, owner: undefined, target: undefined, outside: false, edge: null,
  x: undefined, y: undefined, title: undefined, favicon: undefined,
});
