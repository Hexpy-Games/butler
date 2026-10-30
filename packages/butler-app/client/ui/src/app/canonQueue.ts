import { api } from "./api.ts";
import type { TimelineEvent } from "./types.ts";
import type { CanonHoldDecision, CanonQueueEdit, CanonQueueView } from "../../../shared/canon-queue-contracts.ts";
export type { CanonQueueItem, CanonQueueEdit, CanonQueueView } from "../../../shared/canon-queue-contracts.ts";

type Snapshot = { view: CanonQueueView | null; busy: boolean };
type Reader = { snapshot: Snapshot; listeners: Set<() => void>; controller?: AbortController; revision: number; queued: boolean; dirty: boolean };
const EMPTY: Snapshot = { view: null, busy: false };
const readers = new Map<string, Reader>();
const path = (id: string) => `/sessions/${encodeURIComponent(id)}/canon/queue`;
export const getCanonQueue = (id: string, signal?: AbortSignal) => api<CanonQueueView>(path(id), { signal });
export const editCanonQueue = (id: string, edit: CanonQueueEdit) => api<CanonQueueView>(`${path(id)}/edits`, { method: "POST", body: JSON.stringify(edit) });
export const decideCanonHold = (id: string, epic: string, decision: CanonHoldDecision) =>
  api(`${path(id)}/holds/${encodeURIComponent(epic)}`, { method: "POST", body: JSON.stringify({ decision }) });
export const takeCanonHere = (id: string, epic: string) => api(`${path(id)}/take/${encodeURIComponent(epic)}`, { method: "POST", body: "{}" });
export const canonQueueSnapshot = (id: string) => readers.get(id)?.snapshot ?? EMPTY;

/** Shared by the info toggle and its panel, using only the existing live event stream. */
export function observeCanonQueue(id: string, listener: () => void) {
  let reader = readers.get(id);
  if (!reader) {
    reader = { snapshot: EMPTY, listeners: new Set(), revision: 0, queued: false, dirty: false };
    readers.set(id, reader);
    refresh(id, reader);
  }
  reader.listeners.add(listener);
  return () => {
    reader.listeners.delete(listener);
    if (!reader.listeners.size) { reader.controller?.abort(); readers.delete(id); }
  };
}
function publish(reader: Reader, snapshot: Snapshot) {
  reader.snapshot = snapshot;
  for (const listener of reader.listeners) listener();
}

/** Claim the shared reader synchronously: two mounted hooks cannot start concurrent edits. */
export function beginCanonQueueEdit(id: string, view: CanonQueueView) {
  const reader = readers.get(id);
  if (!reader || reader.snapshot.busy) return null;
  reader.controller?.abort(); reader.revision++;
  publish(reader, { view, busy: true });
  return (next: CanonQueueView) => {
    if (readers.get(id) !== reader) return;
    publish(reader, { view: next, busy: false });
    if (reader.dirty) refresh(id, reader);
  };
}
function refresh(id: string, reader: Reader) {
  reader.dirty = true;
  if (reader.queued || reader.controller || reader.snapshot.busy) return;
  reader.queued = true;
  queueMicrotask(() => {
    reader.queued = false;
    if (readers.get(id) !== reader || reader.snapshot.busy) return;
    reader.dirty = false;
    const controller = new AbortController();
    reader.controller = controller;
    const revision = ++reader.revision;
    void getCanonQueue(id, controller.signal).then(view => {
      if (!controller.signal.aborted && reader.revision === revision && view.session_id === id) publish(reader, { view, busy: false });
    }).catch(() => { /* An unavailable projection has no fabricated section. */ }).finally(() => {
      if (reader.controller !== controller) return;
      reader.controller = undefined;
      if (readers.get(id) === reader && reader.dirty) refresh(id, reader);
    });
  });
}
export function publishCanonQueueEvent(event: TimelineEvent) {
  const payload = event.payload as Record<string, unknown> | undefined;
  for (const [id, reader] of readers) {
    const view = reader.snapshot.view;
    if (event.type === "stream.reconcile_required"
      || (event.type === "canon.queue_changed" && payload?.session_id === id
        && typeof payload.graph_revision === "number" && payload.graph_revision > (view?.graph_revision ?? -1))
      || (event.type === "canon.progress_changed" && view?.chains.some(chain => chain.steps.some(step => step.items.some(item => item.epic_id === payload?.epic_id))))) {
      refresh(id, reader);
    }
  }
}
