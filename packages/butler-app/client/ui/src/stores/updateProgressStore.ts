import { create } from "zustand";
import { api } from "@/app/api";
import type { TimelineEvent, UpdateStatusView, UpdateProgressView } from "@/app/types";

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
  return Boolean(progress && !["idle", "ready", "failed", "completed"].includes(progress.stage));
}

/** A single bounded read on connection/reconnection, never an idle poll. */
export async function refreshUpdateProgress(): Promise<void> {
  try {
    const snapshot = await api<UpdateStatusView>("/updates");
    useUpdateProgressStore.getState().receive(snapshot.progress);
  } catch { /* SSE remains authoritative while the gateway is unavailable. */ }
}

export function updatePercent(progress: UpdateProgressView | null): number | null {
  if (!progress || progress.stage !== "downloading" || !(progress.bytes_total && progress.bytes_total > 0) || progress.bytes_done === null) return null;
  return Math.min(100, Math.max(0, Math.round(progress.bytes_done / progress.bytes_total * 100)));
}

/** The same change-driven source powers hidden-window progress without a mounted row. */
export function subscribeNativeUpdateProgress(): () => void {
  let previous = "";
  const publish = () => {
    const progress = useUpdateProgressStore.getState().progress;
    const stage = progress?.error_code === "update_cancelled" ? "idle" : progress?.stage ?? "idle";
    const percent = updatePercent(progress);
    const key = `${stage}:${percent}`;
    if (key === previous) return;
    previous = key;
    const value = ["idle", "failed", "completed"].includes(stage) ? null
      : stage === "ready" ? 1 : percent === null ? "indeterminate" : percent / 100;
    void window.butlerApp?.setUpdateProgress?.(value).catch(() => {});
  };
  publish();
  const unsubscribe = useUpdateProgressStore.subscribe(publish);
  return () => { unsubscribe(); void window.butlerApp?.setUpdateProgress?.(null).catch(() => {}); };
}
