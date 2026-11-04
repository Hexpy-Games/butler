import { useCallback, useSyncExternalStore } from "react";
import { apiErrorCode } from "@/app/api.ts";
import { getCanon, type CanonOverview } from "@/app/canonApi.ts";
import { singleFlight, subscribeCanonChanges } from "@/app/canonEvents.ts";

type Snapshot = { state: "loading" | "missing" | "error"; canon?: never } | { state: "ready"; canon: CanonOverview };
type Reader = { snapshot: Snapshot; listeners: Set<() => void>; refresh: () => Promise<void>; unsubscribe: () => void };
const loading: Snapshot = { state: "loading" };
const readers = new Map<string, Reader>();

function mount(projectId: string, listener: () => void) {
  let reader = readers.get(projectId);
  if (!reader) {
    const entry: Reader = { snapshot: loading, listeners: new Set(), refresh: async () => {}, unsubscribe: () => {} };
    entry.refresh = singleFlight(async () => {
      if (readers.get(projectId) !== entry) return;
      let snapshot: Snapshot;
      try { snapshot = { state: "ready", canon: await getCanon(projectId) }; }
      catch (error) {
        const missing = (typeof error === "object" && error !== null && "status" in error && error.status === 404)
          || ["project_not_found", "work_model_not_found", "canon_not_found"].includes(apiErrorCode(error) ?? "");
        snapshot = { state: missing ? "missing" : "error" };
      }
      if (readers.get(projectId) !== entry) return;
      entry.snapshot = snapshot;
      for (const notify of entry.listeners) notify();
    });
    readers.set(projectId, entry);
    entry.unsubscribe = subscribeCanonChanges(() => { void entry.refresh(); }, { projectId });
    reader = entry;
    void reader.refresh();
  }
  const current = reader;
  current.listeners.add(listener);
  return () => {
    current.listeners.delete(listener);
    if (!current.listeners.size) { current.unsubscribe(); readers.delete(projectId); }
  };
}

/** Mounted answer blocks share one event-driven project read, with no idle cache. */
export function useChatCanon(projectId: string) {
  const subscribe = useCallback((notify: () => void) => mount(projectId, notify), [projectId]);
  const snapshot = useCallback(() => readers.get(projectId)?.snapshot ?? loading, [projectId]);
  return useSyncExternalStore(subscribe, snapshot);
}
