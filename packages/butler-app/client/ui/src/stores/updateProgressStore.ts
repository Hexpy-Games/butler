import { create } from "zustand";
import type { TimelineEvent, UpdateProgressView } from "@/app/types";

/** Agent snapshot revisions fence late HTTP responses and stream replays. */
export const useUpdateProgressStore = create<{ progress: UpdateProgressView | null; receive: (progress: UpdateProgressView | null | undefined) => void }>((set) => ({
  progress: null,
  receive: (progress) => {
    if (!progress) return;
    set((state) => state.progress && state.progress.revision > progress.revision ? state : { progress });
  },
}));
export function receiveUpdateProgress(event: TimelineEvent): void {
  if (event.type !== "updates.progress") return;
  const value = event.payload?.progress as UpdateProgressView | undefined;
  if (value && typeof value.revision === "number") useUpdateProgressStore.getState().receive(value);
}
export function updateIsRunning(progress: UpdateProgressView | null): boolean {
  return Boolean(progress && !["idle", "failed", "completed"].includes(progress.stage));
}
