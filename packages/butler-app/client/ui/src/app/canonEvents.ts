import type { TimelineEvent } from "./types.ts";
import type { CanonChanged } from "./canonApi.ts";
type Listener = (event: CanonChanged | null) => void;
type Subscription = { projectId: string; sidebar?: boolean };
const listeners = new Map<Listener, Subscription>();
/** Only mounted canon readers subscribe; no idle work or second event stream. */
export function subscribeCanonChanges(listener: Listener, options: Subscription): () => void {
  listeners.set(listener, options);
  return () => { listeners.delete(listener); };
}
export function publishCanonEvent(event: TimelineEvent): void {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (event.type === "stream.reconcile_required" || (event.type === "work_model.changed" && payload?.scope === "tasks")) {
    for (const listener of listeners.keys()) listener(null);
  } else if (event.type === "space.changed" || event.type === "canon.changed") {
    const projectId = payload?.project_id;
    for (const [listener, options] of listeners) {
      if (typeof projectId === "string") {
        if (options.projectId === projectId) listener(payload as unknown as CanonChanged);
      } else if (event.type === "space.changed" && options.sidebar) listener(null);
    }
  }
}
