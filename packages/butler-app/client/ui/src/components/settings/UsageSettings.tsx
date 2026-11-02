import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/app/api";
import { appCopy, useAppLocale } from "@/app/copy";
import type { UsageMonitorView } from "@/app/types";
import { Button, RefreshCcw, Inline, SegmentedControl, Stack, Typo, UsageBars, type UsageBarsEmphasis } from "@/butler-ds";
import { SettingsPage, SettingsSection } from "./SettingsFormComponents";
import { UsageReadout } from "../usage/UsageReadout";
import { usageClock, usageParts, usageShare, usageReadout, usageSeries, usageTimeline, usageTokens } from "../usage/usageTimeline";
import { UsageBreakdown } from "./UsageBreakdown";
import { UsageSessionSelect } from "./UsageSessionSelect";
import { UsageHistory } from "../usage/UsageHistory";
import { useUsageHistory } from "../usage/useUsageHistory";
import { UsageImagesSection } from "./UsageImagesSection";
import { UsageProviderPanel } from "./UsageProviderPanel";

/** Keep one scoped view and the all-chat view per range, rather than every visited chat. */
function rememberView(views: Map<string, UsageMonitorView>, key: string, next: UsageMonitorView) {
  const updated = new Map(views);
  const range = key.split("/")[0]!;
  if (key !== `${range}/`) {
    for (const stored of updated.keys()) if (stored.startsWith(`${range}/`) && stored !== `${range}/`) updated.delete(stored);
  }
  return updated.set(key, next);
}

function useUsageRange(hours: number, session: string | null, revision: number) {
  const key = `${hours}/${session ?? ""}`;
  const [views, setViews] = useState(() => new Map<string, UsageMonitorView>());
  const allRevisions = useRef(new Map<number, number>());
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setPending(key); setError(null);
    const params = new URLSearchParams({ since_hours: String(hours) });
    if (session) params.set("session_id", session);
    const needsAll = allRevisions.current.get(hours) !== revision;
    const requests = session && needsAll ? [[`${hours}/`, new URLSearchParams({ since_hours: String(hours) })], [key, params]] as const : session || needsAll ? [[key, params]] as const : [];
    Promise.all(requests.map(async ([requestKey, query]) => {
      const next = await api<UsageMonitorView>(`/usage-monitor?${query}`);
      if (cancelled) return;
      if (requestKey === `${hours}/`) allRevisions.current.set(hours, revision);
      setViews(previous => rememberView(previous, requestKey, next));
    })).catch(() => { if (!cancelled) setError(key); })
      .finally(() => { if (!cancelled) setPending(null); });
    return () => { cancelled = true; };
  }, [hours, session, revision, key]);
  return { view: views.get(key) ?? null, allView: views.get(`${hours}/`) ?? null, loading: pending === key, error: error === key };
}

function periodDelta(view: UsageMonitorView | null, hours: number): string | undefined {
  if (!view) return undefined;
  const copy = appCopy.composer.usage;
  if (view.model.totalTokens === 0) return copy.emptyRange;
  const previous = view.previousPeriod?.totalTokens;
  const label = copy.previousPeriod(hours);
  if (!previous) return copy.previousEmpty(label);
  const delta = (view.model.totalTokens - previous) / previous * 100;
  return Math.abs(delta) < 1 ? copy.similar : copy.delta(label, String(Math.round(Math.abs(delta))), delta > 0);
}

export function UsageSettings() {
  const locale = useAppLocale();
  const [hours, setHours] = useState(24);
  const [session, setSession] = useState<string | null>(null);
  const pickerTrigger = useRef<HTMLButtonElement>(null);
  const showAll = () => { pickerTrigger.current?.focus(); setPickerOpen(true); };
  const [pickerOpen, setPickerOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision(v => v + 1);
  const result = useUsageRange(hours, session, revision);
  const history = useUsageHistory(revision);
  const providers = (result.allView ?? result.view)?.providerUsage.providers ?? [];
  const [selection, setSelection] = useState<{ scope: string; index: number | null }>({ scope: "", index: null });
  const scope = `${hours}/${session}/${result.view?.generated_at}`;
  const selected = selection.scope === scope ? selection.index : null;
  const timeline = useMemo(() => usageTimeline(result.view, 31), [result.view, locale]);
  const bucket = selected === null ? undefined : timeline.buckets[selected];
  const parts = usageParts(result.view, bucket, true);
  const [emphasis, setEmphasis] = useState<UsageBarsEmphasis | null>(null);
  const copy = appCopy.composer.usage;
  const ranges = [{ value: "24", label: copy.day }, { value: "168", label: copy.week }, { value: "720", label: copy.month }];
  const sessions = [...(result.allView?.topSessions ?? result.view?.topSessions ?? [])];
  const selectedSession = result.view?.topSessions.find(item => item.sessionId === session);
  if (selectedSession && !sessions.some(item => item.sessionId === session)) sessions.push(selectedSession);
  sessions.sort((a, b) => b.totalTokens - a.totalTokens);

  return <SettingsPage>
    <SettingsSection id="usage-overview" kind="status" title={copy.overviewTitle}
      state={result.error && !result.view ? "error" : "ready"} errorMessage={appCopy.interfacePanels.usageFailed} onRetry={refresh}
      actions={<>
        <SegmentedControl ariaLabel={copy.period} size="sm" options={ranges} value={String(hours)} onValueChange={v => setHours(Number(v))} />
        <Button type="button" size="sm" variant="outline" disabled={result.loading} onClick={refresh}><RefreshCcw size="sm" />{appCopy.common.refresh}</Button>
      </>}>
      <Stack gap="lg">
        <Inline justify="between" cross="center" gap="md" wrap>
          <Stack grow basis="md" gap="xs" minWidth="0" maxWidth="field">
            <UsageSessionSelect triggerRef={pickerTrigger} open={pickerOpen} onOpenChange={setPickerOpen} range={ranges.find(r => r.value === String(hours))!.label} sessions={sessions} value={session} onChange={setSession} /></Stack>
          <Typo.Caption>{result.view ? copy.updated(usageClock(Date.parse(result.view.generated_at))) : "—"}</Typo.Caption>
        </Inline>
        <UsageReadout view={result.view} values={usageReadout(result.view, bucket)} label={bucket?.label}
          panel selected={Boolean(bucket)} showCost delta={periodDelta(result.view, hours)} share={session && result.allView?.model.totalTokens
            ? usageShare((result.view?.model.totalTokens ?? 0) / result.allView.model.totalTokens) : undefined}
          parts={parts} onEmphasis={setEmphasis} />
        <UsageBars {...timeline} series={usageSeries()} size="panel" yTicks={{ format: usageTokens }} selectedIndex={selected} emphasis={parts ? emphasis : null}
          onSelect={index => setSelection({ scope, index })} state={!result.view ? "loading" : "ready"}
          emptyLabel={copy.noUsage} loadingLabel={copy.loading} ariaLabel={copy.chartLabel} />
        <UsageBreakdown loading={!result.view} onShowAll={showAll} view={result.view} sessions={sessions} allTotal={result.allView?.model.totalTokens ?? 0} selected={session} onSelect={setSession} />
      </Stack>
    </SettingsSection>
    <SettingsSection id="usage-history" title={copy.historyTitle} kind="status"><UsageHistory history={history} /></SettingsSection>
    <UsageImagesSection revision={revision} onRetry={refresh} />
    {providers.length ? <SettingsSection id="usage-providers" title={copy.remaining} kind="status" state={!result.view ? "loading" : "ready"}>
      <UsageProviderPanel providers={providers} />
    </SettingsSection> : null}
  </SettingsPage>;
}
