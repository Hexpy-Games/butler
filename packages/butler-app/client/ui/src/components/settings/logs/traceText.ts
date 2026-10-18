import { appCopy } from "@/app/copy.ts";
import type { TagTone } from "@/butler-ds";
import { formatBytes, formatDuration } from "./logFormat";
import type { TraceSpan, TraceView } from "./traceApi";
import { isHttpStep, type TraceStep } from "./traceModel";

export function stepTitle(span: TraceSpan): string {
  const copy = appCopy.settings.logs.trace;
  const steps = copy.steps as Record<string, string>;
  const attrs = span.attrs ?? {};
  // A request the agent received names its route ("앱 요청 · POST /messages"); one it sent stays "HTTP 요청".
  if (span.name === "http.request" && typeof attrs.route === "string" && attrs.route) {
    return [copy.steps["http.server"], [attrs.method, attrs.route].filter((part) => typeof part === "string").join(" ")].join(" · ");
  }
  const base = steps[span.name] ?? (span.title || span.name);
  const attempt = attrs.attempt;
  const attempts = attrs.attempts;
  if (span.name === "model.request" && typeof attempt === "number" && typeof attempts === "number" && attempts > 1) {
    return `${base} ${attempt}/${attempts}`;
  }
  const subject = span.name === "tool.call" ? attrs.name : span.name === "mcp.call" ? attrs.method : undefined;
  return typeof subject === "string" && subject ? `${base} · ${subject}` : base;
}

function httpStatus(span: TraceSpan): number | null {
  const status = span.attrs?.status;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

/** Status beside the title: the HTTP status (its own, else its latest HTTP child's), wait, failure or running. */
export function stepTag(step: TraceStep): { text: string; tone: TagTone } | null {
  const copy = appCopy.settings.logs.trace;
  const http = [step, ...step.children.filter(isHttpStep).reverse()].map((candidate) => httpStatus(candidate.span))
    .find((status) => status !== null);
  if (http !== undefined && http !== null) return { text: String(http), tone: http >= 400 ? "danger" : "neutral" };
  if (step.span.status === "wait") return { text: copy.wait, tone: "warning" };
  if (step.span.status === "error") return { text: copy.failed, tone: "danger" };
  return step.running ? { text: copy.running, tone: "neutral" } : null;
}

/** Shown elsewhere (IDs, timing, the HTTP tabs) or internal; never a detail field. */
const HIDDEN = new Set(["trace_id", "span_id", "parent_span_id", "started_at", "start", "log_level"]);
const HTTP_TAB_KEYS = new Set(["method", "path", "url", "route", "status", "request_headers", "response_headers", "headers"]);

/** Attributes a step's title already spells out. */
const TITLE_KEYS: Record<string, readonly string[]> = {
  "model.request": ["attempt", "attempts"], "tool.call": ["name"], "mcp.call": ["method"],
};

/** A step's detail fields: its attributes, labelled, minus what the row or the summary already shows. */
export function stepFields(step: TraceStep, trace: TraceView): Array<{ key: string; label: string; value: string }> {
  const labels = appCopy.settings.logs.trace.attrs;
  const http = isHttpStep(step);
  const titled = TITLE_KEYS[step.span.name] ?? [];
  return Object.entries(step.span.attrs ?? {}).flatMap(([key, value]) => {
    if (HIDDEN.has(key) || titled.includes(key) || (http && HTTP_TAB_KEYS.has(key))) return [];
    if (value === null || value === undefined || value === "") return [];
    if ((key === "chat_id" && value === trace.chat_id) || (key === "turn_id" && value === trace.turn_id)) return [];
    // The status word repeats the row's dot and tag.
    if (key === "status" && typeof value === "string") return [];
    return [{ key, label: labels[key] ?? key, value: fieldText(key, value) }];
  });
}

function fieldText(key: string, value: unknown): string {
  if (typeof value === "number" && key.endsWith("_ms")) return formatDuration(value);
  if (typeof value === "number" && key.endsWith("_bytes")) return formatBytes(value);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** "412ms" under a second, else "2.58초" / "2.58s"; whole seconds drop the decimals. */
export function formatTraceMs(ms: number): string {
  const copy = appCopy.settings.logs.trace;
  if (ms <= 0) return copy.seconds("0");
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return copy.seconds(String(Number((ms / 1000).toFixed(2))));
}

/** "+0.58초": where the step starts on the trace. */
export function formatTraceStart(offset: number): string {
  return `+${appCopy.settings.logs.trace.seconds((offset / 1000).toFixed(2))}`;
}
