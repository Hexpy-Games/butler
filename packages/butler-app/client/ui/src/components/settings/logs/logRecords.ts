import type { LogFilter, LogPage, LogRecord, LogWindow } from "./logsApi";

/** Rows the list keeps while live records arrive; older ones stay reachable through 더 보기. */
export const LOG_ROW_LIMIT = 500;

/** A record's identity: the same record from a page and from the live stream share it. */
export function recordKey(row: LogRecord): string {
  return [row.ts, row.process, row.category, row.event, row.span_id ?? "", row.msg].join("|");
}

/** `newer` before `current`, each record once. */
function newestFirst(newer: readonly LogRecord[], current: readonly LogRecord[]): LogRecord[] {
  const seen = new Set<string>();
  return [...newer, ...current].filter((row) => {
    const key = recordKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Client-side filter for live rows, matching the agent's query semantics. */
export function matchesFilter(row: LogRecord, filter: LogFilter): boolean {
  if (filter.level && row.level.toLowerCase() !== filter.level.toLowerCase()) return false;
  if (filter.source !== "all" && row.process !== filter.source) return false;
  if (filter.category && row.category !== filter.category && !row.category.startsWith(`${filter.category}.`)) return false;
  return !filter.q.trim() || JSON.stringify(row).includes(filter.q.trim());
}

export interface LogListState {
  status: "loading" | "ready" | "failed";
  rows: LogRecord[];
  /** The next page's window, or null when everything older is shown. */
  next: LogWindow | null;
  since?: string;
  /** Live records waiting behind 새 줄 N개 while the list's top is out of view. */
  pending: LogRecord[];
  /** Live records that arrived before the first page. */
  early: LogRecord[];
}

export type LogListAction =
  | { type: "reset"; since?: string }
  | { type: "page"; page: LogPage; window: LogWindow; first: boolean }
  | { type: "failed" }
  | { type: "live"; record: LogRecord; atTop: boolean }
  | { type: "showPending" };

export const EMPTY_LOG_LIST: LogListState = { status: "loading", rows: [], next: null, pending: [], early: [] };

/** Past the limit, the oldest rows leave; 더 보기 resumes at the oldest kept row. */
function capped(state: LogListState, rows: LogRecord[]): LogListState {
  if (rows.length <= LOG_ROW_LIMIT) return { ...state, rows };
  const kept = rows.slice(0, LOG_ROW_LIMIT);
  return { ...state, rows: kept, next: { since: state.since, until: kept[kept.length - 1]!.ts, cursor: null } };
}

function nextWindow(page: LogPage, window: LogWindow): LogWindow | null {
  return page.exhausted || !page.cursor ? null : { since: window.since, until: window.until, cursor: page.cursor };
}

export function logListReducer(state: LogListState, action: LogListAction): LogListState {
  switch (action.type) {
    case "reset":
      return { ...EMPTY_LOG_LIST, since: action.since };
    case "failed":
      return { ...state, status: "failed" };
    case "page": {
      const next = nextWindow(action.page, action.window);
      // A page for a list that has since reset or moved on is dropped.
      if (!action.first && state.next !== action.window) return state;
      // 더 보기 is asked for, so it grows the list; only live growth is capped.
      if (!action.first) return { ...state, next, rows: newestFirst(state.rows, action.page.rows) };
      return capped({ ...state, status: "ready", early: [], next }, newestFirst(state.early, action.page.rows));
    }
    case "live": {
      if (state.status !== "ready") return { ...state, early: newestFirst([action.record], state.early).slice(0, LOG_ROW_LIMIT) };
      if (state.rows.some((row) => recordKey(row) === recordKey(action.record))) return state;
      if (action.atTop && state.pending.length === 0) return capped(state, [action.record, ...state.rows]);
      return { ...state, pending: newestFirst([action.record], state.pending).slice(0, LOG_ROW_LIMIT) };
    }
    case "showPending":
      return capped({ ...state, pending: [] }, newestFirst(state.pending, state.rows));
  }
}
