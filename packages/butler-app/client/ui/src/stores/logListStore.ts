import { create } from "zustand";
import type { LogFilter } from "../components/settings/logs/logsApi.ts";

export const EMPTY_LOG_FILTER: LogFilter = { q: "", level: "", source: "all", category: "", period: "day" };

interface LogListView {
  /** What the log list asks for; kept while 메시지 추적 is open, so 로그 returns to the same list. */
  filter: LogFilter;
  live: boolean;
  /** The open row (its record key), scrolled back into view on return. */
  openKey: string | null;
  setFilter: (change: Partial<LogFilter>) => void;
  setLive: (live: boolean) => void;
  toggleRow: (key: string) => void;
  reset: () => void;
}

export const useLogListView = create<LogListView>((set) => ({
  filter: EMPTY_LOG_FILTER,
  live: false,
  openKey: null,
  setFilter: (change) => set((state) => ({ filter: { ...state.filter, ...change } })),
  setLive: (live) => set({ live }),
  toggleRow: (key) => set((state) => ({ openKey: state.openKey === key ? null : key })),
  reset: () => set({ filter: EMPTY_LOG_FILTER, live: false, openKey: null }),
}));
