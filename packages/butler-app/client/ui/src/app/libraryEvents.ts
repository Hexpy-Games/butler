import { create } from "zustand";
import type { TimelineEvent } from "./types";
export const useLibraryVersion = create<{ version: number }>(() => ({ version: 0 }));
export function libraryChanged() { useLibraryVersion.setState(s => ({ version: s.version + 1 })); }
/** Invalidate after committed delivery or stream recovery; idle does no work. */
export function publishLibraryEvent(event: TimelineEvent) {
  if (event.type === "outputs.changed" || event.type === "stream.reconcile_required" || (event.type === "turn.state_changed" && event.payload?.turn?.state === "delivered")) libraryChanged();
}
