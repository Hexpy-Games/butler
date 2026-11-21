import { useCallback, useEffect, useState } from "react";
import { getAppCopy, type AppCopy } from "../../../butler-i18n/src/index.ts";
import { useConversation } from "@/conversation/live";
import { Button, ListGroup, ListGroupItem, ListRow, Text } from "@/ds";
import { useAppLocale } from "@/i18n";
import { LoadState, SettingsScreen } from "@/settings/layout";
import type { SystemEventListView, SystemEventSummary } from "@/settings/types";

export default function SystemSettings() {
  const app = getAppCopy(useAppLocale()), S = app.settings;
  const { client, reconcile } = useConversation();
  const [view, setView] = useState<SystemEventListView | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState(false);
  const load = useCallback(async (offset = 0) => {
    if (!client) return;
    setLoading(true); setError(false);
    try {
      const next = await client.request<SystemEventListView>(`/system-events?limit=20&offset=${offset}`);
      setView(old => ({ ...next, events: offset ? [...(old?.events ?? []), ...next.events] : next.events }));
    } catch { setError(true); }
    finally { setLoading(false); }
  }, [client]);
  useEffect(() => { void load(); }, [load, reconcile]);
  return <SettingsScreen title={S.sections.system} description={S.sectionDescriptions.system}>
    <ListGroup label={S.pageSections.systemEvents} footer={S.descriptions.systemEvents}>
      <ListGroupItem><Button label={app.common.refresh} disabled={loading} onPress={() => void load()} /></ListGroupItem>
      {!view || error ? <LoadState error={error} onRetry={() => void load()} /> : <>
        {view.events.map(event => <SystemEventRow key={event.id} event={event} />)}
        {!view.events.length ? <ListGroupItem><Text variant="caption">{S.descriptions.systemEventsEmpty}</Text></ListGroupItem> : null}
      </>}
      {view?.pagination.has_more ? <ListGroupItem><Button label={app.common.more} disabled={loading} onPress={() => void load(view.events.length)} /></ListGroupItem> : null}
    </ListGroup>
  </SettingsScreen>;
}

function systemEventTitle(event: SystemEventSummary, labels: AppCopy["settings"]["systemEventLabels"]["titles"]) {
  if (event.kind === "profile_consolidation") return labels.profile;
  if (event.kind === "consolidation_run") return labels.consolidation;
  const jobId = event.metrics.find(metric => metric.label === "job_id")?.value;
  if (jobId === "session-sync") return labels.sessionSync;
  if (jobId === "context-maintenance") return labels.contextMaintenance;
  if (jobId === "consolidation-cycle") return labels.consolidationCycle;
  return event.title;
}

function systemEventStatus(status: string, labels: AppCopy["settings"]["systemEventLabels"]["statuses"]) {
  if (status === "ok") return labels.ok;
  if (status === "completed") return labels.completed;
  if (status === "failed") return labels.failed;
  if (status === "running") return labels.running;
  if (status === "not_run") return labels.notRun;
  return labels.unknown;
}

function systemEventMetricValue(value: SystemEventSummary["metrics"][number]["value"], labels: AppCopy["settings"]["systemEventLabels"]["values"]) {
  if (typeof value === "boolean") return value ? labels.yes : labels.no;
  if (value === "deep") return labels.deep;
  if (value === "basic") return labels.basic;
  if (value === "off") return labels.off;
  return String(value);
}

function SystemEventRow({ event }: { event: SystemEventSummary }) {
  const S = getAppCopy(useAppLocale()).settings, labels = S.systemEventLabels;
  const date = event.occurred_at ? new Date(event.occurred_at) : null;
  const time = date ? Number.isNaN(date.getTime()) ? event.occurred_at : new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(date) : "";
  const model = event.model_ref ? `${event.model_ref}${event.uses_butler_model ? ` · ${S.options.consolidationModelDefault}` : ""}` : "";
  const metrics = event.metrics.filter(m => m.label !== "raw_text_included" && m.label !== "job_id").slice(0, 8)
    .map(m => `${labels.metrics[m.label] ?? m.label}: ${systemEventMetricValue(m.value, labels.values)}`).join(" · ");
  const duration = event.duration_ms === undefined ? undefined : event.duration_ms < 1000 ? `${event.duration_ms}ms` : `${Math.round(event.duration_ms / 100) / 10}s`;
  return <ListRow title={systemEventTitle(event, labels.titles)} description={[systemEventStatus(event.status, labels.statuses), time, model].filter(Boolean).join(" · ") + (metrics ? `\n${metrics}` : "")}
    descriptionLines={3} meta={duration} />;
}
