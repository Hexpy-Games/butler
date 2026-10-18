import { useCallback, useEffect, useRef, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { notifyError } from "@/app/notifications.ts";
import { queryLogs, type LogFilter, type LogRecord } from "./logsApi";
import { subscribeLogs } from "./logsTransport";

export const EMPTY_LOG_FILTER: LogFilter = { q: "", level: "", source: "all", category: "", period: "day" };
const LIVE_LIMIT = 500;

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

/** Client-side filter for live rows, matching the agent's query semantics. */
export function matchesFilter(row: LogRecord, filter: LogFilter): boolean {
  if (filter.level && row.level.toLowerCase() !== filter.level.toLowerCase()) return false;
  if (filter.source !== "all" && row.process !== filter.source) return false;
  if (filter.category && row.category !== filter.category && !row.category.startsWith(`${filter.category}.`)) return false;
  return !filter.q.trim() || JSON.stringify(row).includes(filter.q.trim());
}

export function useLogViewer(): LogViewerState {
  const [filter, setFilterState] = useState<LogFilter>(EMPTY_LOG_FILTER);
  const [rows, setRows] = useState<LogRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [paging, setPaging] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [live, setLive] = useState(false);
  const [buffer, setBuffer] = useState<LogRecord[]>([]);
  const atTop = useRef(true);
  const buffered = useRef(0);
  buffered.current = buffer.length;

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setBuffer([]);
    queryLogs(filter).then((page) => {
      if (cancelled) return;
      setRows(page.rows);
      setCursor(page.exhausted ? null : page.cursor);
      setState("ready");
    }).catch(() => { if (!cancelled) setState("failed"); });
    return () => { cancelled = true; };
  }, [filter, attempt]);

  useEffect(() => {
    if (!live) return;
    return subscribeLogs({
      onRecord: (row) => {
        if (!matchesFilter(row, filter)) return;
        // Live rows join the list only while its top is in view and nothing waits.
        if (atTop.current && buffered.current === 0) setRows((current) => [row, ...current]);
        else setBuffer((current) => [row, ...current].slice(0, LIVE_LIMIT));
      },
      onError: () => setLive(false),
    });
  }, [live, filter]);

  const loadMore = useCallback(() => {
    if (!cursor || paging) return;
    setPaging(true);
    queryLogs(filter, cursor).then((page) => {
      setRows((current) => [...current, ...page.rows]);
      setCursor(page.exhausted ? null : page.cursor);
    }).catch((error) => notifyError(error, appCopy.settings.logs.loadFailed, { id: "logs-more" }))
      .finally(() => setPaging(false));
  }, [cursor, filter, paging]);

  const showPending = useCallback(() => {
    setRows((current) => [...buffer, ...current]);
    setBuffer([]);
  }, [buffer]);

  const setFilter = useCallback((next: Partial<LogFilter>) => setFilterState((current) => ({ ...current, ...next })), []);
  const setAtTop = useCallback((value: boolean) => { atTop.current = value; }, []);

  return {
    filter,
    setFilter,
    rows,
    failed: state === "failed",
    loading: state === "loading" || paging,
    hasMore: cursor !== null,
    loadMore,
    reload: () => setAttempt((value) => value + 1),
    live,
    setLive,
    pending: buffer.length,
    showPending,
    setAtTop,
  };
}
