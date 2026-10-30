import { useId } from "react";
import { appCopy } from "@/app/copy.ts";
import { Button, CopyButton, DisclosureRow, Inline, KeyValueRow, Stack, Tag, Typo } from "@/butler-ds";
import { openLogTrace } from "@/stores/logTraceStore.ts";
import { isTraceId } from "./traceApi";
import { formatDuration, formatLogTime, hasDetail, httpAttrs, logTitle, prettyJson, severityLabel, severityOf, severityTone } from "./logFormat";
import { LogHttpTabs } from "./LogHttpTabs";
import { LogJson } from "./LogJson";
import type { LogRecord } from "./logsApi";

/** One record: message, level, category · process · duration and time; open, its fields and JSON. */
export function LogRow({ record, open, onToggle }: { record: LogRecord; open: boolean; onToggle: () => void }) {
  const panelId = useId();
  const severity = severityOf(record.level);
  const description = [record.category, record.process, record.duration_ms !== undefined ? formatDuration(record.duration_ms) : null]
    .filter(Boolean).join(" · ");
  return (
    <DisclosureRow
      title={logTitle(record)}
      description={description}
      attention={severity === "error" ? "error" : severity === "warn" ? "warning" : undefined}
      meta={
        <Inline gap="xs" cross="center" wrap={false}>
          <Tag size="sm" tone={severityTone(record.level)}>{severityLabel(record.level)}</Tag>
          <Typo.Caption as="span" tone="tertiary" numeric="tabular">{formatLogTime(record.ts)}</Typo.Caption>
        </Inline>
      }
      controlsId={panelId}
      open={open}
      onToggle={onToggle}
      data-test-class="log-row"
      data-log-open={open ? "true" : undefined}
    >
      {hasDetail(record) ? <LogDetail record={record} /> : null}
    </DisclosureRow>
  );
}

function LogDetail({ record }: { record: LogRecord }) {
  const http = httpAttrs(record);
  const traceId = record.trace_id;
  return (
    <Stack gap="md">
      <LogFields record={record} />
      {http ? <LogHttpTabs record={record} attrs={http} /> : <LogJson record={record} />}
      {isTraceId(traceId) ? (
        <Inline justify="end">
          <Button type="button" size="sm" variant="outline" data-test-class="log-row-trace"
            onClick={() => openLogTrace({ traceId })}>
            {appCopy.settings.logs.trace.viewWhole}
          </Button>
        </Inline>
      ) : null}
    </Stack>
  );
}

function LogFields({ record }: { record: LogRecord }) {
  const fields = appCopy.settings.logs.fields;
  const ids: Array<[string, string | undefined]> = [
    [fields.trace, record.trace_id], [fields.span, record.span_id], [fields.chat, record.chat_id], [fields.turn, record.turn_id],
  ];
  return (
    <Stack gap="none">
      <KeyValueRow label={fields.time} value={record.ts} valueTextSize="caption" />
      {record.msg && logTitle(record) !== record.msg
        ? <KeyValueRow label={fields.message} value={record.msg} valueTextSize="caption" /> : null}
      <KeyValueRow label={fields.event} value={record.event} valueTextSize="caption" />
      {ids.map(([label, value]) => value ? <KeyValueRow key={label} label={label} value={<IdValue value={value} />} /> : null)}
      {record.error !== undefined ? (
        <KeyValueRow label={fields.error} detailLayout="stack" valueTextSize="caption"
          value={errorText(record.error)} />
      ) : null}
    </Stack>
  );
}

/** An error's message when it has one; otherwise the error as JSON. */
function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  const message = error && typeof error === "object" ? (error as { message?: unknown }).message : undefined;
  return typeof message === "string" && Object.keys(error as object).length === 1 ? message : prettyJson(error);
}

function IdValue({ value }: { value: string }) {
  const copy = appCopy.settings.logs;
  return (
    <Inline gap="xs" cross="center" wrap={false}>
      <Typo.Code>{value}</Typo.Code>
      <CopyButton label={copy.copy} copiedLabel={copy.copied} text={value} />
    </Inline>
  );
}
