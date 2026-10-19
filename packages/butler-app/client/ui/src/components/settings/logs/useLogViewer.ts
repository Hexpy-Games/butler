import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import { useLogListView } from "@/stores/logListStore.ts";
import { EMPTY_LOG_LIST, logListReducer, matchesFilter } from "./logRecords";
import { periodSince, queryLogs, type LogFilter, type LogRecord } from "./logsApi";
import { useLiveLogs } from "./useLiveLogs";

export interface LogViewerState {
  filter: LogFilter;
  setFilter: (next: Partial<LogFilter>) => void;
  rows: LogRecord[];
  failed: boolean;
  loading: boolean;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
  live: boolean;
  setLive: (live: boolean) => void;
  pending: number;
  showPending: () => void;
  /** Whether the top of the list is in view; live rows wait while it is not. */
  setAtTop: (atTop: boolean) => void;
}

export function useLogViewer(): LogViewerState {
  // Filter and live outlive the list (메시지 추적 and back); the rows are read again.
  const filter = useLogListView((state) => state.filter);
  const live = useLogListView((state) => state.live);
  const setFilter = useLogListView((state) => state.setFilter);
  const setLive = useLogListView((state) => state.setLive);
  const [list, dispatch] = useReducer(logListReducer, EMPTY_LOG_LIST);
  const [paging, setPaging] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const atTop = useRef(true);
  const current = useRef(filter);
  current.current = filter;

  useEffect(() => {
    let cancelled = false;
    // The period starts now, once; every later page of this query reuses it.
    const bounds = { since: periodSince(filter.period) };
    dispatch({ type: "reset", since: bounds.since });
    queryLogs(filter, bounds).then((page) => {
      if (!cancelled) dispatch({ type: "page", page, window: bounds, first: true });
    }).catch(() => { if (!cancelled) dispatch({ type: "failed" }); });
    return () => { cancelled = true; };
  }, [filter, attempt]);

  useLiveLogs(live, (record) => {
    if (matchesFilter(record, current.current)) dispatch({ type: "live", record, atTop: atTop.current });
  }, () => {
    setLive(false);
    notifyStatus(appCopy.settings.logs.liveLost, { id: "logs-live" });
  });

  const { next } = list;
  const loadMore = useCallback(() => {
    if (!next || paging) return;
    setPaging(true);
    queryLogs(filter, next).then((page) => dispatch({ type: "page", page, window: next, first: false }))
      .catch((error) => notifyError(error, appCopy.settings.logs.loadFailed, { id: "logs-more" }))
      .finally(() => setPaging(false));
  }, [filter, next, paging]);

  const setAtTop = useCallback((value: boolean) => { atTop.current = value; }, []);

  return {
    filter,
    setFilter,
    rows: list.rows,
    failed: list.status === "failed",
    loading: list.status === "loading" || paging,
    hasMore: next !== null,
    loadMore,
    reload: () => setAttempt((value) => value + 1),
    live,
    setLive,
    pending: list.pending.length,
    showPending: () => dispatch({ type: "showPending" }),
    setAtTop,
  };
}
