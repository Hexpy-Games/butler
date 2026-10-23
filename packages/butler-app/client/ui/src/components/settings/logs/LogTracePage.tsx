import { useCallback, useEffect, useMemo, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { apiErrorCode } from "@/app/api.ts";
import { SpanAxis, Stack } from "@/butler-ds";
import { SettingsPage, SettingsSection } from "../SettingsFormComponents";
import { readTrace, traceTargetKey, type LogTraceTarget, type TraceView } from "./traceApi";
import { initialOpen, traceSteps, traceTotal, visibleSteps, type TraceStep } from "./traceModel";
import { formatTraceMs } from "./traceText";
import { TraceStepRow } from "./TraceStepRow";
import { TraceSummary } from "./TraceSummary";

type TraceLoad = { key: string; state: "loading" } | { key: string; state: "error" | "missing" }
  | { key: string; state: "ready"; trace: TraceView };

/** Settings › 로그 › 메시지 추적: 요약, then every step on one shared time axis. */
export function LogTracePage({ target }: { target: LogTraceTarget }) {
  useAppLocale();
  const copy = appCopy.settings.logs.trace;
  const { load, reload } = useTrace(target);
  const steps = useMemo(() => (load.state === "ready" ? traceSteps(load.trace) : []), [load]);
  const state = load.state === "ready" ? "ready" : load.state === "loading" ? "loading" : load.state === "missing" ? "empty" : "error";
  return (
    <SettingsPage>
      {load.state === "ready" ? <TraceSummary trace={load.trace} steps={steps} /> : null}
      <SettingsSection id="trace-steps" kind="list" title={copy.sections.steps} state={state} onRetry={reload}
        errorMessage={copy.loadFailed} emptyMessage={copy.notFound}
        description={load.state === "ready" && load.trace.truncated ? copy.partial : undefined}>
        {load.state === "ready" ? <TraceSteps key={load.key} trace={load.trace} steps={steps} /> : null}
      </SettingsSection>
    </SettingsPage>
  );
}

function useTrace(target: LogTraceTarget) {
  const key = traceTargetKey(target);
  const [revision, setRevision] = useState(0);
  const [load, setLoad] = useState<TraceLoad>({ key, state: "loading" });
  useEffect(() => {
    let cancelled = false;
    setLoad({ key, state: "loading" });
    readTrace(target).then((trace) => { if (!cancelled) setLoad({ key, state: "ready", trace }); })
      .catch((error: unknown) => {
        if (!cancelled) setLoad({ key, state: apiErrorCode(error) === "log_not_found" ? "missing" : "error" });
      });
    return () => { cancelled = true; };
    // The key names the target; a new object for the same trace does not reload it.
  }, [key, revision]);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  return { load, reload };
}

/** The axis and the visible rows: roots and their single-child chains open, the first error open. */
function TraceSteps({ trace, steps }: { trace: TraceView; steps: readonly TraceStep[] }) {
  const [open, setOpen] = useState(() => initialOpen(steps));
  const total = traceTotal(trace);
  const toggle = (id: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  return (
    <Stack gap="sm">
      <SpanAxis total={total} inset="row" format={formatTraceMs} />
      <Stack gap="none">
        {visibleSteps(steps, open).map((step, index) => (
          <TraceStepRow key={step.id} trace={trace} step={step} total={total} index={index} open={open.has(step.id)}
            onToggle={() => toggle(step.id)} />
        ))}
      </Stack>
    </Stack>
  );
}
