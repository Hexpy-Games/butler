import type { TimelineEvent } from "./types";
export interface DocumentUpdate { id: string; rev: number; author: "user" | "butler"; changed: { start_line: number; end_line: number }[] }
const listeners = new Set<(event: DocumentUpdate | null) => void>();
export function subscribeDocumentUpdates(listener: (event: DocumentUpdate | null) => void) {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function publishDocumentEvent(event: TimelineEvent) {
  if (event.type === "document.updated" || event.type === "stream.reconcile_required") {
    for (const listener of listeners) listener(event.type === "document.updated" ? event.payload as unknown as DocumentUpdate : null);
  }
}
