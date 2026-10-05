import type { TimelineEvent } from "./types.ts";
interface MemoryEvent { type: string; payload: Record<string, unknown> }
const listeners = new Set<(event: MemoryEvent) => void>();
export function publishMemoryEvent(event: TimelineEvent) {
  if (event.type === "memory.operation" || event.type === "stream.reconcile_required" || event.type === "personalization.updated" || event.type === "project.updated" || event.type === "project.created" || (event.type === "turn.state_changed" && ["delivered", "failed", "cancelled"].includes(event.payload?.turn?.state ?? ""))) {
    for (const listener of listeners) listener({ type: event.type, payload: (event.payload ?? {}) as Record<string, unknown> });
  }
}
export function onMemoryEvent(listener: (event: MemoryEvent) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
