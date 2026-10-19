import type { SpanBarTone } from "@/butler-ds";
import type { TraceSpan, TraceView } from "./traceApi";

/** A span placed in the step tree, in display order (each parent before its subtree). */
export interface TraceStep {
  id: string;
  span: TraceSpan;
  depth: number;
  parent: TraceStep | null;
  children: TraceStep[];
  offset: number;
  /** A running span reaches to the end of the trace. */
  duration: number;
  running: boolean;
  /** The request record a received request (http.server) logged: shown in this step's details, not as a row. */
  exchange: TraceSpan | null;
}

/** The access record of a request the App sent the agent: part of its http.server span, not a step of its own. */
export function isReceivedExchange(span: TraceSpan): boolean {
  return span.name === "http.request" && span.category === "http.server";
}

const TONES: readonly SpanBarTone[] = ["model", "tool", "app", "agent", "error", "wait"];

/** Steps in display order: roots by start, each followed by its children by start. */
export function traceSteps(trace: TraceView): TraceStep[] {
  const total = traceTotal(trace);
  const ids = new Set(trace.spans.map((span) => span.span_id));
  const children = new Map<string | null, TraceSpan[]>();
  for (const span of trace.spans) {
    const parent = span.parent_span_id && ids.has(span.parent_span_id) ? span.parent_span_id : null;
    children.set(parent, [...(children.get(parent) ?? []), span]);
  }
  const ordered: TraceStep[] = [];
  const place = (span: TraceSpan, parent: TraceStep | null) => {
    const offset = Math.max(0, span.start_offset_ms);
    const running = span.duration_ms === null;
    const step: TraceStep = {
      id: span.span_id, span, depth: parent ? parent.depth + 1 : 0, parent, children: [], offset, running,
      duration: running ? Math.max(0, total - offset) : Math.max(0, span.duration_ms ?? 0), exchange: null,
    };
    parent?.children.push(step);
    ordered.push(step);
    for (const child of byStart(children.get(span.span_id) ?? [])) {
      if (isReceivedExchange(child) && !step.exchange && (children.get(child.span_id) ?? []).length === 0) step.exchange = child;
      else place(child, step);
    }
  };
  for (const root of byStart(children.get(null) ?? [])) place(root, null);
  return ordered;
}

function byStart(spans: TraceSpan[]): TraceSpan[] {
  return spans.map((span, index) => ({ span, index }))
    .sort((a, b) => a.span.start_offset_ms - b.span.start_offset_ms || a.index - b.index)
    .map(({ span }) => span);
}

export function traceTotal(trace: TraceView): number {
  return Math.max(trace.duration_ms, ...trace.spans.map((span) => span.start_offset_ms + (span.duration_ms ?? 0)), 0);
}

/**
 * Rows open at first: each root, and down a single-child chain until the first
 * row with several children, so one level of real steps shows; then the first
 * error (the innermost one) with every row above it.
 */
export function initialOpen(steps: readonly TraceStep[]): Set<string> {
  const open = new Set<string>();
  const openChain = (step: TraceStep) => {
    if (step.children.length === 0) return;
    open.add(step.id);
    if (step.children.length === 1) openChain(step.children[0]!);
  };
  for (const root of steps.filter((step) => !step.parent)) openChain(root);
  const error = firstError(steps);
  for (let step: TraceStep | null = error; step; step = step.parent) open.add(step.id);
  return open;
}

export function firstError(steps: readonly TraceStep[]): TraceStep | null {
  return steps.find((step) => step.span.status === "error"
    && !step.children.some((child) => child.span.status === "error")) ?? null;
}

/** Steps whose every ancestor is open. */
export function visibleSteps(steps: readonly TraceStep[], open: ReadonlySet<string>): TraceStep[] {
  return steps.filter((step) => {
    for (let parent = step.parent; parent; parent = parent.parent) if (!open.has(parent.id)) return false;
    return true;
  });
}

export function retryCount(steps: readonly TraceStep[]): number {
  return steps.filter((step) => step.span.name === "retry.wait").length;
}

export function stepTone(step: TraceStep): SpanBarTone {
  return (TONES as readonly string[]).includes(step.span.tone) ? step.span.tone as SpanBarTone : "agent";
}

export function stepAttention(step: TraceStep): "error" | "warning" | undefined {
  if (step.span.status === "error") return "error";
  return step.span.status === "wait" || step.span.status === "warn" ? "warning" : undefined;
}

/** A step with an HTTP exchange: its own request, or the received request it folded in. */
export function isHttpStep(step: TraceStep): boolean {
  return step.span.name === "http.request" || step.exchange !== null;
}

/** The span that carries the step's HTTP attributes. */
export function httpSpan(step: TraceStep): TraceSpan {
  return step.exchange ?? step.span;
}
