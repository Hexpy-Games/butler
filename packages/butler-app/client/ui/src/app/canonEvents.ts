import { useCanonSidebarState } from "./canonSidebarState.ts";
import { useButlerStore } from "./store.ts";
import type { TimelineEvent } from "./types.ts";
import type { CanonChanged, CanonProgressChanged } from "./canonApi.ts";
type Listener = (event: CanonChanged | CanonProgressChanged | null) => void;
type Subscription = { projectId: string; sidebar?: boolean };
const listeners = new Map<Listener, Subscription>();
/** Only mounted canon readers subscribe; no idle work or second event stream. */
export function subscribeCanonChanges(listener: Listener, options: Subscription): () => void {
  listeners.set(listener, options);
  return () => { listeners.delete(listener); };
}
export function publishCanonEvent(event: TimelineEvent): void {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (event.type === "canon.changed" && payload?.deleted === true && typeof payload.id === "string" && typeof payload.project_id === "string") {
    useCanonSidebarState.getState().forgetEpic(payload.project_id, payload.id);
    const app = useButlerStore.getState();
    if (app.view.kind === "project-dashboard" && app.view.epicId === payload.id) app.setView({ ...app.view, epicId: undefined });
  }
  if (event.type === "stream.reconcile_required" || event.type === "canon.queue_changed") {
    // A queue change names only its session, and binds or unbinds that session's 과제.
    for (const listener of listeners.keys()) listener(null);
  } else if (event.type === "space.changed" || event.type === "canon.changed" || event.type === "canon.progress_changed") {
    const projectId = payload?.project_id;
    for (const [listener, options] of listeners) {
      if (typeof projectId === "string") {
        if (options.projectId === projectId) listener(payload as unknown as CanonChanged | CanonProgressChanged);
      } else if (event.type === "space.changed" && options.sidebar) listener(null);
    }
  }
}
/**
 * One read at a time: a change during a read runs exactly one more afterwards.
 * A burst of events cannot queue reads that are all discarded on arrival.
 */
export function singleFlight(read: () => Promise<void>): () => Promise<void> {
  let current: Promise<void> | null = null, dirty = false;
  return () => {
    if (current) { dirty = true; return current; }
    current = (async () => {
      try { do { dirty = false; await read(); } while (dirty); } finally { current = null; }
    })();
    return current;
  };
}
