import { api } from "@/app/api.ts";

export type LogPreset = "minimal" | "standard" | "detailed" | "full";
export type LogSeverity = "error" | "warn" | "info" | "debug" | "trace";
export const LOG_PRESETS: readonly LogPreset[] = ["minimal", "standard", "detailed", "full"];
export const LOG_SEVERITIES: readonly LogSeverity[] = ["error", "warn", "info", "debug", "trace"];

/** One structured log record as GET /logs and GET /logs/live return it. */
export interface LogRecord {
  ts: string;
  level: string;
  process: string;
  category: string;
  event: string;
  msg: string;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  chat_id?: string;
  turn_id?: string;
  duration_ms?: number;
  attrs?: Record<string, unknown>;
  error?: unknown;
  content?: unknown;
  content_len?: number;
  content_hash?: string;
  body_ref?: string;
}

export interface LogPage {
  rows: LogRecord[];
  cursor: string | null;
  exhausted: boolean;
}

export interface LogConfigView {
  effective: { level: LogPreset; category_levels: Record<string, string> };
  full_expires_at: string | null;
  freed_bytes: number;
}

export interface LogStoreUsage {
  id: string;
  bytes: number;
  limit_bytes: number;
  retention_h: number;
  oldest_ts: string | null;
}

export interface LogStorageView {
  stores: LogStoreUsage[];
}

export interface LogFilter {
  q: string;
  level: string;
  source: string;
  category: string;
  period: LogPeriod;
}

export type LogPeriod = "hour" | "day" | "week" | "all";
export const LOG_PERIODS: readonly LogPeriod[] = ["hour", "day", "week", "all"];
const PERIOD_HOURS: Record<LogPeriod, number | null> = { hour: 1, day: 24, week: 24 * 7, all: null };
export const LOG_PAGE_SIZE = 50;

/** The RFC 3339 start of a period, or undefined for all time. */
export function periodSince(period: LogPeriod, now = Date.now()): string | undefined {
  const hours = PERIOD_HOURS[period];
  return hours === null ? undefined : new Date(now - hours * 3_600_000).toISOString();
}

/**
 * One page of a query. The agent's cursor binds every filter value, so a
 * query's `since` and `until` are fixed once and reused for each later page.
 */
export interface LogWindow {
  since?: string;
  until?: string;
  cursor?: string | null;
}

export function queryLogs(filter: LogFilter, window: LogWindow): Promise<LogPage> {
  const params = new URLSearchParams({ limit: String(LOG_PAGE_SIZE), source: filter.source || "all" });
  if (filter.q.trim()) params.set("q", filter.q.trim());
  if (filter.level) params.set("level", filter.level);
  if (filter.category) params.set("category", filter.category);
  if (window.since) params.set("since", window.since);
  if (window.until) params.set("until", window.until);
  if (window.cursor) params.set("cursor", window.cursor);
  return api<LogPage>(`/logs?${params.toString()}`);
}

export function readLogConfig(): Promise<LogConfigView> {
  return api<LogConfigView>("/logs/config");
}

export function writeLogConfig(level: LogPreset, categoryLevels: Record<string, string>): Promise<LogConfigView> {
  return api<LogConfigView>("/logs/config", {
    method: "PUT",
    body: JSON.stringify({ level, category_levels: categoryLevels }),
  });
}

export function readLogStorage(): Promise<LogStorageView> {
  return api<LogStorageView>("/logs/storage");
}

export function clearLogs(): Promise<{ freed_bytes: number }> {
  return api<{ freed_bytes: number }>("/logs", { method: "DELETE" });
}
