import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/app/api";
import { appCopy, useAppLocale } from "@/app/copy";
import type { UsageMonitorView } from "@/app/types";
import { RefreshCcw, IconButton, Inline, SegmentedControl, Stack, Typo, UsageBars } from "@/butler-ds";
import { SettingsPage, SettingsSection } from "./SettingsFormComponents";
import { UsageReadout } from "../usage/UsageReadout";
import { usageClock, usageShare, usageReadout, usageSeries, usageTimeline, usageTokens } from "../usage/usageTimeline";
import { UsageBreakdown } from "./UsageBreakdown";
import { UsageSessionSelect, usageSessionTitle } from "./UsageSessionSelect";
import { UsageProviderPanel } from "./UsageProviderPanel";

/** A range/session key prevents stale responses from replacing a newly selected scope. */
const allRevisions = new Map<number, number>();
let lastViews = new Map<string, UsageMonitorView>();
export function resetUsageSettingsCache(): void { lastViews.clear(); allRevisions.clear(); }

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
  const [views, setViews] = useState(() => new Map(lastViews));
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setPending(key); setError(null);
    const params = new URLSearchParams({ since_hours: String(hours) });
    if (session) params.set("session_id", session);
    const needsAll = allRevisions.get(hours) !== revision;
    const requests = session && needsAll ? [[`${hours}/`, new URLSearchParams({ since_hours: String(hours) })], [key, params]] as const : session || needsAll ? [[key, params]] as const : [];
    Promise.all(requests.map(async ([requestKey, query]) => {
      const next = await api<UsageMonitorView>(`/usage-monitor?${query}`);
      if (cancelled) return;
      if (requestKey === `${hours}/`) allRevisions.set(hours, revision);
      lastViews = rememberView(lastViews, requestKey, next);
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
  const [selection, setSelection] = useState<{ scope: string; index: number | null }>({ scope: "", index: null });
  const scope = `${hours}/${session}/${result.view?.generated_at}`;
  const selected = selection.scope === scope ? selection.index : null;
  const timeline = useMemo(() => usageTimeline(result.view, 31), [result.view, locale]);
  const bucket = selected === null ? undefined : timeline.buckets[selected];
  const copy = appCopy.composer.usage;
  const ranges = [{ value: "24", label: copy.day }, { value: "168", label: copy.week }, { value: "720", label: copy.month }];
  const sessions = [...(result.allView?.topSessions ?? result.view?.topSessions ?? [])];
  const selectedSession = result.view?.topSessions.find(item => item.sessionId === session);
  if (selectedSession && !sessions.some(item => item.sessionId === session)) sessions.push(selectedSession);
  sessions.sort((a, b) => b.totalTokens - a.totalTokens);
  const label = `${session ? usageSessionTitle(sessions.find(s => s.sessionId === session)) : copy.all} · ${copy.recent(ranges.find(r => r.value === String(hours))!.label)}`;
  return <SettingsPage>
    <SettingsSection id="usage-overview" kind="status"
      state={result.error && !result.view ? "error" : "ready"} errorMessage={appCopy.interfacePanels.usageFailed} onRetry={refresh}>
      <Stack gap="lg">
        <Inline justify="between" cross="end" gap="md" wrap>
          <Stack grow basis="md" gap="xs" minWidth="0"><Typo.Caption>{copy.chats}</Typo.Caption>
            <UsageSessionSelect triggerRef={pickerTrigger} open={pickerOpen} onOpenChange={setPickerOpen} range={ranges.find(r => r.value === String(hours))!.label} sessions={sessions} value={session} onChange={setSession} /></Stack>
          <Stack gap="xs"><Typo.Caption>{copy.period}</Typo.Caption>
            <SegmentedControl ariaLabel={copy.period} size="sm" options={ranges} value={String(hours)} onValueChange={v => setHours(Number(v))} /></Stack>
          <Inline gap="xs"><Typo.Caption>{result.view ? copy.updated(usageClock(Date.parse(result.view.generated_at))) : "—"}</Typo.Caption>
            <IconButton label={appCopy.common.refresh} disabled={result.loading} onClick={refresh}><RefreshCcw size="sm" /></IconButton></Inline>
        </Inline>
        <UsageReadout view={result.view} values={usageReadout(result.view, bucket)} label={bucket?.label ?? label}
          panel selected={Boolean(bucket)} showCost delta={periodDelta(result.view, hours)} share={session && result.allView?.model.totalTokens
            ? usageShare((result.view?.model.totalTokens ?? 0) / result.allView.model.totalTokens) : undefined} />
        <UsageBars {...timeline} series={usageSeries()} size="panel" yTicks={{ format: usageTokens }} selectedIndex={selected}
          onSelect={index => setSelection({ scope, index })} state={!result.view ? "loading" : "ready"}
          emptyLabel={copy.noUsage} loadingLabel={copy.loading} ariaLabel={copy.chartLabel} />
        <UsageBreakdown loading={!result.view} onShowAll={showAll} view={result.view} sessions={sessions} allTotal={result.allView?.model.totalTokens ?? 0} selected={session} onSelect={setSession} />
      </Stack>
    </SettingsSection>
    {(result.allView ?? result.view)?.providerUsage.providers.length ? <SettingsSection id="usage-providers" title={copy.remaining} kind="status" state={!result.view ? "loading" : "ready"}>
      <UsageProviderPanel providers={(result.allView ?? result.view)?.providerUsage.providers ?? []} />
    </SettingsSection> : null}
  </SettingsPage>;
}
