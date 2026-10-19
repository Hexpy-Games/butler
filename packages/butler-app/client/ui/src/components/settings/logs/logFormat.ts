import { appCopy } from "@/app/copy.ts";
import type { TagTone } from "@/butler-ds";
import { LOG_SEVERITIES, type LogRecord, type LogSeverity } from "./logsApi";

const UNITS = ["B", "KB", "MB", "GB"] as const;

export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Clock time for today's records; month, day and minute for older ones. */
export function formatLogTime(ts: string, now = new Date()): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  const today = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(undefined, today
    ? { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
    : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

export function severityOf(level: string): LogSeverity | null {
  const value = level.toLowerCase();
  return (LOG_SEVERITIES as readonly string[]).includes(value) ? value as LogSeverity : null;
}

export function severityLabel(level: string): string {
  const severity = severityOf(level);
  return severity ? appCopy.settings.logs.severity[severity] : level;
}

export function severityTone(level: string): TagTone {
  const severity = severityOf(level);
  if (severity === "error") return "danger";
  if (severity === "warn") return "warning";
  return "neutral";
}

/** Request/response attributes, when the record describes an HTTP exchange. */
export function httpAttrs(record: LogRecord): Record<string, unknown> | null {
  const attrs = record.attrs ?? {};
  return ["method", "url", "route", "path", "status"].some((key) => key in attrs) ? attrs : null;
}

const TARGET_LIMIT = 64;

/** Where a request went: the route template or path, or a URL's host and path (no scheme or query). */
export function httpTarget(attrs: Record<string, unknown>): string | null {
  const route = attrs.route ?? attrs.path;
  if (typeof route === "string" && route) return route;
  if (typeof attrs.url !== "string" || !attrs.url) return null;
  try {
    const url = new URL(attrs.url);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return attrs.url.split(/[?#]/u)[0] || null;
  }
}

/**
 * A row title from the record's HTTP attributes: "POST /sessions/{id}/messages · 500".
 * Long targets end in an ellipsis; the full value stays in the opened row.
 */
export function logTitle(record: LogRecord): string {
  if (record.process.startsWith("app.")) return record.msg || record.event;
  const attrs = httpAttrs(record);
  const fallback = record.msg || record.event;
  if (!attrs) return fallback;
  const method = typeof attrs.method === "string" ? attrs.method.toUpperCase() : null;
  const target = httpTarget(attrs);
  if (!method && !target) return fallback;
  const shown = target && target.length > TARGET_LIMIT ? `${target.slice(0, TARGET_LIMIT - 1)}…` : target;
  const request = [method, shown].filter(Boolean).join(" ");
  return attrs.status === undefined || attrs.status === null ? request : `${request} · ${String(attrs.status)}`;
}

const SUMMARY_KEYS = new Set(["ts", "level", "category", "process", "msg", "duration_ms"]);

/** True when the record holds anything the collapsed row does not already show. */
export function hasDetail(record: LogRecord): boolean {
  return Object.entries(record).some(([key, value]) => {
    if (SUMMARY_KEYS.has(key) || value === undefined || value === null) return false;
    // App titles use prose; keep the stable event id available in details.
    if (key === "attrs") return Object.keys(value as object).length > 0;
    return key !== "event" || record.process.startsWith("app.") && record.event !== record.msg;
  });
}

export function prettyJson(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

/** Header maps as returned (already redacted), one `name: value` per line. */
export function formatHeaders(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  return Object.entries(value as Record<string, unknown>)
    .map(([name, header]) => `${name}: ${typeof header === "string" ? header : JSON.stringify(header)}`)
    .join("\n");
}
