import type { TimelineEvent } from "./types.ts";
import type { CanonChanged } from "./canonApi.ts";
type Listener = (event: CanonChanged | null) => void;
const listeners = new Set<Listener>();
/** Only mounted canon readers subscribe; no idle work or second event stream. */
export function subscribeCanonChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function publishCanonEvent(event: TimelineEvent): void {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (event.type === "stream.reconcile_required" || (event.type === "work_model.changed" && payload?.scope === "tasks")) {
    for (const listener of listeners) listener(null);
  } else if (event.type === "canon.changed" && typeof payload?.project_id === "string") {
    for (const listener of listeners) listener(payload as unknown as CanonChanged);
  }
}
