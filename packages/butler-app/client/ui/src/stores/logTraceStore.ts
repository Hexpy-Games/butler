import { create } from "zustand";
import { useButlerStore } from "../app/store.ts";
import type { LogTraceTarget } from "../components/settings/logs/traceApi.ts";
import { useLogListView } from "./logListStore.ts";
import { useSettingsUIStore } from "./settingsUIStore.ts";

interface LogTraceRoute {
  /** The trace Settings › 로그 shows as 메시지 추적; null shows the log list. */
  target: LogTraceTarget | null;
  open: (target: LogTraceTarget) => void;
  close: () => void;
}

export const useLogTraceRoute = create<LogTraceRoute>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));

/** 로그 보기: Settings › 로그 › 메시지 추적 for one trace. */
export function openLogTrace(target: LogTraceTarget): void {
  useLogTraceRoute.getState().open(target);
  useButlerStore.getState().openSettings("logs");
}

/** Leaving 로그 (another section, or closing settings) leaves the trace and the list's filters too. */
function leaveLogs() {
  useLogTraceRoute.getState().close();
  useLogListView.getState().reset();
}
useSettingsUIStore.subscribe((state, previous) => {
  if (state.activeSection !== previous.activeSection && state.activeSection !== "logs") leaveLogs();
});
useButlerStore.subscribe((state, previous) => {
  if (previous.view.kind === "settings" && state.view.kind !== "settings") leaveLogs();
});
