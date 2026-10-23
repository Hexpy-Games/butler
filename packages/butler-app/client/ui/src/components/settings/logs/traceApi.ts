import { api } from "@/app/api.ts";
import type { LogPage, LogRecord } from "./logsApi";

/** Which trace to show: by its ID, by a turn, or by a persisted App message. */
export type LogTraceTarget =
  | { traceId: string }
  | { turnId: string }
  | { chatId: string; messageId: string };

export type TraceSpanStatus = "ok" | "error" | "wait" | "warn";
export type TraceSpanTone = "model" | "tool" | "app" | "agent" | "error" | "wait";

/** One span of GET /logs/trace; parents precede their children. */
export interface TraceSpan {
  span_id: string;
  parent_span_id: string | null;
  name: string;
  category: string;
  process: string;
  start_offset_ms: number;
  /** Null while the span is still running. */
  duration_ms: number | null;
  status: TraceSpanStatus;
  tone: TraceSpanTone;
  title: string;
  child_count: number;
  has_details: boolean;
  attrs: Record<string, unknown> | null;
}

export interface TraceView {
  trace_id: string;
  started_at: string | null;
  duration_ms: number;
  outcome: "ok" | "error" | string;
  model: string | null;
  chat_id: string | null;
  turn_id: string | null;
  spans: TraceSpan[];
  truncated: boolean;
}

/** A W3C trace ID, the only form GET /logs/trace/{id} accepts. */
export function isTraceId(value: unknown): value is string {
  return typeof value === "string" && /^(?!0{32})[0-9a-f]{32}$/u.test(value);
}

export function traceTargetKey(target: LogTraceTarget): string {
  if ("traceId" in target) return `trace:${target.traceId}`;
  if ("turnId" in target) return `turn:${target.turnId}`;
  return `message:${target.chatId}:${target.messageId}`;
}

export function readTrace(target: LogTraceTarget): Promise<TraceView> {
  if ("traceId" in target) return api<TraceView>(`/logs/trace/${encodeURIComponent(target.traceId)}`);
  const params = "turnId" in target
    ? new URLSearchParams({ turn_id: target.turnId })
    : new URLSearchParams({ chat_id: target.chatId, message_id: target.messageId });
  return api<TraceView>(`/logs/trace?${params.toString()}`);
}

/** Pages the trace's own records may span before a span's record is given up on. */
const RECORD_PAGES = 5;

/**
 * The stored record behind a span (an HTTP exchange's body reference and error
 * body live there, not on the span): the trace's records, newest first.
 */
export async function readSpanRecord(traceId: string, spanId: string, event: string): Promise<LogRecord | null> {
  let cursor: string | null = null;
  for (let page = 0; page < RECORD_PAGES; page += 1) {
    const params = new URLSearchParams({ trace_id: traceId, source: "all", limit: "200" });
    if (cursor) params.set("cursor", cursor);
    const result: LogPage = await api<LogPage>(`/logs?${params.toString()}`);
    const match = result.rows.find((row) => row.span_id === spanId && row.event === event);
    if (match) return match;
    if (result.exhausted || !result.cursor) return null;
    cursor = result.cursor;
  }
  return null;
}
