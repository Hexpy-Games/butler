import { appCopy } from "@/app/copy.ts";
import { findSessionSummary } from "@/app/optimisticSession.ts";
import { sessionDisplayTitle } from "@/app/sessionTitle.ts";
import { useButlerStore } from "@/app/store.ts";
import { CopyButton, Inline, KeyValueRow, Tag, Typo } from "@/butler-ds";
import { SettingsSection } from "../SettingsFormComponents";
import type { TraceView } from "./traceApi";
import { retryCount, type TraceStep } from "./traceModel";
import { formatTraceMs } from "./traceText";

/** 요약: result and retries, total time, model, start, chat and the trace ID. */
export function TraceSummary({ trace, steps }: { trace: TraceView; steps: readonly TraceStep[] }) {
  const copy = appCopy.settings.logs.trace;
  const chat = useButlerStore((state) => (trace.chat_id ? findSessionSummary(state.navigation, trace.chat_id) : null));
  const failed = trace.outcome === "error";
  const retries = retryCount(steps);
  return (
    <SettingsSection id="trace-summary" kind="info" title={copy.sections.summary}>
      <KeyValueRow label={copy.fields.result} data-test-class="trace-result" value={(
        <Inline as="span" gap="xs" cross="center" wrap={false}>
          {failed ? <Tag size="sm" tone="danger">{copy.outcome.error}</Tag> : copy.outcome.ok}
          {retries > 0 ? <Typo.Text as="span">{`${failed ? "" : "· "}${copy.retries(retries)}`}</Typo.Text> : null}
        </Inline>
      )} />
      <KeyValueRow label={copy.fields.duration} value={formatTraceMs(trace.duration_ms)} />
      {trace.model ? <KeyValueRow label={copy.fields.model} value={trace.model} /> : null}
      {trace.started_at ? <KeyValueRow label={copy.fields.started} value={formatStarted(trace.started_at)} /> : null}
      {trace.chat_id ? <KeyValueRow label={copy.fields.chat} value={chat ? sessionDisplayTitle(chat) : trace.chat_id} /> : null}
      {/* The 32-character ID shows its ends (full on hover); the copy button copies all of it. */}
      <KeyValueRow label={copy.fields.traceId} value={(
        <Inline as="span" gap="xs" cross="center" wrap={false}>
          <Typo.Code title={trace.trace_id} data-test-class="trace-id">{`${trace.trace_id.slice(0, 8)}…${trace.trace_id.slice(-6)}`}</Typo.Code>
          <CopyButton label={copy.copyId} copiedLabel={appCopy.settings.logs.copied} text={trace.trace_id} />
        </Inline>
      )} />
    </SettingsSection>
  );
}

/** "10월 18일 14:02:31" in the reader's locale. */
function formatStarted(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return new Intl.DateTimeFormat(undefined, {
    month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date);
}
