import type { StateCreator } from "zustand";

type Navigation = { view: unknown; rightOpen: boolean; rightTab: string; activeChatId: string };
type EditGuard = { leave: () => Promise<boolean> };
let editor: EditGuard | undefined;

/** The mounted inline editor owns the decision; every store navigation uses it. */
export function registerCanonEditor(guard: EditGuard): () => void {
  editor = guard;
  return () => { if (editor === guard) editor = undefined; };
}

function leavesInspector<T extends Navigation>(state: T, patch: Partial<T>): boolean {
  return (patch.view !== undefined && JSON.stringify(patch.view) !== JSON.stringify(state.view))
    || (patch.rightOpen !== undefined && patch.rightOpen !== state.rightOpen)
    || (patch.rightTab !== undefined && patch.rightTab !== state.rightTab)
    || (patch.activeChatId !== undefined && patch.activeChatId !== state.activeChatId);
}

export function withCanonEditGuard<T extends Navigation>(creator: StateCreator<T>): StateCreator<T> {
  return (set, get, api) => {
    const guarded: typeof set = (update, replace?) => {
      const patch = typeof update === "function" ? update(get()) : update;
      const commit = () => replace ? set(patch as T, true) : set(patch);
      if (!editor || !leavesInspector(get(), patch)) { commit(); return; }
      const active = editor;
      void active.leave().then(leave => { if (leave) commit(); });
    };
    // Include direct store writes as well as actions created below.
    api.setState = guarded;
    return creator(guarded, get, api);
  };
}
