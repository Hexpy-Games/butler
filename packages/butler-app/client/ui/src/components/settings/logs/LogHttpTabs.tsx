import { useEffect, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { KeyValueRow, Stack, Tabs, TabsContent, TabsList, TabsTrigger, Typo } from "@/butler-ds";
import { RawBlock } from "../DeveloperLogRawBlock";
import { formatDuration, formatHeaders, prettyJson } from "./logFormat";
import { LogJson } from "./LogJson";
import type { LogRecord } from "./logsApi";
import { readLogBody } from "./logsTransport";

/** 요청 / 응답 / JSON for a record with HTTP attributes. */
export function LogHttpTabs({ record, attrs }: { record: LogRecord; attrs: Record<string, unknown> }) {
  const copy = appCopy.settings.logs;
  // A finished exchange (it has a status) carries the response body; otherwise the request's.
  const bodyOnResponse = attrs.status !== undefined;
  return (
    <Tabs defaultValue="request">
      <TabsList variant="line">
        <TabsTrigger value="request">{copy.tabs.request}</TabsTrigger>
        <TabsTrigger value="response">{copy.tabs.response}</TabsTrigger>
        <TabsTrigger value="json">{copy.tabs.json}</TabsTrigger>
      </TabsList>
      <TabsContent value="request">
        <Stack gap="xs">
          {attrs.method !== undefined ? <KeyValueRow label={copy.fields.method} value={String(attrs.method)} /> : null}
          {attrs.url ?? attrs.route ? <KeyValueRow label={copy.fields.url} value={String(attrs.url ?? attrs.route)} /> : null}
          <Headers value={attrs.request_headers ?? attrs.headers} />
          {bodyOnResponse ? null : <LogBody record={record} />}
        </Stack>
      </TabsContent>
      <TabsContent value="response">
        <Stack gap="xs">
          {attrs.status !== undefined ? <KeyValueRow label={copy.fields.status} value={String(attrs.status)} /> : null}
          {record.duration_ms !== undefined
            ? <KeyValueRow label={copy.fields.duration} value={formatDuration(record.duration_ms)} /> : null}
          <Headers value={attrs.response_headers} />
          {bodyOnResponse ? <LogBody record={record} /> : null}
        </Stack>
      </TabsContent>
      <TabsContent value="json"><LogJson record={record} /></TabsContent>
    </Tabs>
  );
}

function Headers({ value }: { value: unknown }) {
  const text = formatHeaders(value);
  return text ? <RawBlock title={appCopy.settings.logs.fields.headers} value={text} compact /> : null;
}

/** The body: inline content, or the stored body fetched on demand, or why there is none. */
function LogBody({ record }: { record: LogRecord }) {
  const copy = appCopy.settings.logs;
  const reference = record.body_ref;
  const [body, setBody] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!reference) return;
    let cancelled = false;
    readLogBody(reference).then((text) => { if (!cancelled) setBody(text); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [reference]);
  if (record.content !== undefined) return <RawBlock title={copy.fields.body} value={prettyJson(record.content)} />;
  if (!reference) return <Typo.Caption tone="tertiary">{copy.bodyUnavailable}</Typo.Caption>;
  if (failed) return <Typo.Caption tone="tertiary">{copy.bodyFailed}</Typo.Caption>;
  return <RawBlock title={copy.fields.body} value={body === null ? "" : readable(body)} />;
}

/** Stored bodies are JSON; show them indented when they parse. */
function readable(body: string): string {
  try {
    return prettyJson(JSON.parse(body));
  } catch {
    return body;
  }
}
