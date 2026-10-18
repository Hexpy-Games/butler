import { useEffect, useState } from "react";
import { KeyValueRow, Stack } from "@/butler-ds";
import { LogHttpTabs } from "./LogHttpTabs";
import type { LogRecord } from "./logsApi";
import { readSpanRecord, type TraceView } from "./traceApi";
import { isHttpStep, type TraceStep } from "./traceModel";
import { stepFields } from "./traceText";

export function hasStepDetail(step: TraceStep, trace: TraceView): boolean {
  return isHttpStep(step) || stepFields(step, trace).length > 0;
}

/** An opened step: its fields, and for an HTTP exchange the 요청 / 응답 / JSON tabs of the Logs page. */
export function TraceStepDetail({ id, trace, step, open }: { id: string; trace: TraceView; step: TraceStep; open: boolean }) {
  const fields = stepFields(step, trace);
  return (
    <Stack id={id} gap="md">
      {fields.length > 0 ? (
        <Stack gap="none">
          {fields.map((field) => (
            <KeyValueRow key={field.key} label={field.label} value={field.value} valueTextSize="caption" />
          ))}
        </Stack>
      ) : null}
      {isHttpStep(step) ? <HttpTabs trace={trace} step={step} open={open} /> : null}
    </Stack>
  );
}

/** The span's stored record once the row opens (its body and error live there); the span itself until then. */
function HttpTabs({ trace, step, open }: { trace: TraceView; step: TraceStep; open: boolean }) {
  const [record, setRecord] = useState<LogRecord | null>(null);
  const wanted = open && step.span.has_details;
  useEffect(() => {
    if (!wanted || record) return;
    let cancelled = false;
    readSpanRecord(trace.trace_id, step.id, "http.request")
      .then((found) => { if (!cancelled && found) setRecord(found); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [wanted, record, trace.trace_id, step.id]);
  const shown = record ?? spanRecord(trace, step);
  return <LogHttpTabs record={shown} attrs={shown.attrs ?? {}} />;
}

/** The span as a log record, for the tabs to show before (or without) the stored one. */
function spanRecord(trace: TraceView, step: TraceStep): LogRecord {
  const { span } = step;
  const started = trace.started_at ? new Date(new Date(trace.started_at).getTime() + step.offset) : null;
  return {
    ts: started && !Number.isNaN(started.getTime()) ? started.toISOString() : "",
    level: span.status === "error" ? "ERROR" : "DEBUG",
    process: span.process,
    category: span.category,
    event: span.name,
    msg: span.title,
    trace_id: trace.trace_id,
    span_id: span.span_id,
    ...(span.parent_span_id ? { parent_span_id: span.parent_span_id } : {}),
    ...(span.duration_ms === null ? {} : { duration_ms: span.duration_ms }),
    attrs: span.attrs ?? {},
  };
}
