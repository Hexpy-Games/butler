import { Fragment, useEffect, useState } from "react";
import { getAppCopy, type AppCopy } from "../../../butler-i18n/src/index.ts";
import { useConversation } from "@/conversation/live";
import { Button, ListRow, Text, showToast } from "@/ds";
import { useAppLocale } from "@/i18n";
import { GroupInset, LoadState, SettingsGroup, SettingsScreen } from "@/settings/layout";
import { SelectRow } from "@/settings/rows";
import { compactTokens } from "@/settings/format";
import { useModelCatalog } from "@/settings/useModelCatalog";
import type { ImageUsageSelection, ImageUsageValues, ImageUsageView, ProviderQuotaResultView, UsageHistoryView, UsageMonitorView } from "@/settings/types";

export default function UsageSettings() {
  const app = getAppCopy(useAppLocale()), S = app.settings, usage = app.composer.usage;
  const { client, reconcile } = useConversation();
  const [hours, setHours] = useState("24"), [revision, refresh] = useState(0);
  const [view, setView] = useState<UsageMonitorView | null>(null), [history, setHistory] = useState<UsageHistoryView | null>(null);
  const [error, setError] = useState(false), [historyError, setHistoryError] = useState(false), [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setLoading(true); setError(false); setView(null);
    void client.request<UsageMonitorView>(`/usage-monitor?since_hours=${hours}`).then(next => { if (!cancelled) setView(next); })
      .catch(() => { if (!cancelled) setError(true); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [client, hours, revision, reconcile]);
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setHistoryError(false);
    void client.request<UsageHistoryView>("/usage-history").then(next => { if (!cancelled) setHistory(next); }).catch(() => { if (!cancelled) setHistoryError(true); });
    return () => { cancelled = true; };
  }, [client, revision, reconcile]);
  useEffect(() => {
    if (historyError && history) showToast({ message: app.interfacePanels.usageFailed, tone: "error" });
  }, [historyError, history, app.interfacePanels.usageFailed]);
  const reload = () => refresh(n => n + 1);
  return <SettingsScreen title={S.sections.usage} description={S.sectionDescriptions.usage}>
    <SettingsGroup title={usage.overviewTitle}>
      <SelectRow title={usage.period} value={hours} options={[{ value: "24", label: usage.day }, { value: "168", label: usage.week }, { value: "720", label: usage.month }]} onSelect={setHours} />
      <GroupInset><Button label={app.common.refresh} disabled={loading} onPress={reload} /></GroupInset>
      {!view ? <GroupInset><LoadState error={error} message={app.interfacePanels.usageFailed} onRetry={reload} /></GroupInset> : <UsageOverview view={view} hours={Number(hours)} />}
    </SettingsGroup>
    <SettingsGroup title={usage.historyTitle}>
      {!history ? <GroupInset><LoadState error={historyError} message={app.interfacePanels.usageFailed} onRetry={reload} /></GroupInset> : <UsageHistory history={history} />}
    </SettingsGroup>
    <UsageImages revision={revision} />
    {view?.providerUsage.providers.length ? <SettingsGroup title={usage.remaining}>
      {view.providerUsage.providers.map(provider => <UsageProvider key={provider.providerId} provider={provider} />)}
    </SettingsGroup> : null}
  </SettingsScreen>;
}

function periodDelta(view: UsageMonitorView, hours: number, copy: AppCopy["composer"]["usage"]) {
  if (view.model.totalTokens === 0) return copy.emptyRange;
  const previous = view.previousPeriod?.totalTokens, label = copy.previousPeriod(hours);
  if (!previous) return copy.previousEmpty(label);
  const delta = (view.model.totalTokens - previous) / previous * 100;
  return Math.abs(delta) < 1 ? copy.similar : copy.delta(label, String(Math.round(Math.abs(delta))), delta > 0);
}

function UsageOverview({ view, hours }: { view: UsageMonitorView; hours: number }) {
  const locale = useAppLocale(), usage = getAppCopy(locale).composer.usage, model = view.model;
  const cost = view.cost.available ? view.cost.estimatedUsd : null;
  const costText = !cost ? "—" : cost < 0.01 ? usage.tinyCost : new Intl.NumberFormat(locale, { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol" }).format(cost);
  const ratio = model.promptTokens ? Math.round(model.cachedTokens / model.promptTokens * 100) : 0;
  const clock = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(view.generated_at));
  return <>
    <GroupInset><Text variant="caption">{usage.updated(clock)}</Text></GroupInset>
    <GroupInset><Text variant="h2">{compactTokens(model.totalTokens, locale)}</Text></GroupInset><GroupInset><Text variant="caption">{usage.tokens}</Text></GroupInset>
    <GroupInset><Text variant="caption">{periodDelta(view, hours, usage)}</Text></GroupInset>
    <GroupInset><Text variant="caption">{usage.requests(new Intl.NumberFormat(locale).format(model.requestCount))}</Text></GroupInset>
    <ListRow title={usage.newInput} meta={compactTokens(Math.max(0, model.promptTokens - model.cachedTokens), locale)} />
    <ListRow title={usage.cached} meta={`${compactTokens(model.cachedTokens, locale)} · ${ratio}%`} />
    <ListRow title={usage.output} meta={compactTokens(model.outputTokens, locale)} />
    <ListRow title={usage.estimatedCost} meta={costText} />
  </>;
}

function durationMinutes(totalMinutes: number, copy: AppCopy["composer"]["usage"]) {
  const minutes = Math.max(0, Math.floor(totalMinutes)), hours = Math.floor(minutes / 60), rest = minutes % 60;
  return [hours ? copy.durationHours(hours) : "", rest || !hours ? copy.elapsedMinutes(rest) : ""].filter(Boolean).join(" ");
}

function UsageHistory({ history }: { history: UsageHistoryView }) {
  const locale = useAppLocale(), copy = getAppCopy(locale).composer.usage;
  const date = (key: string) => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${key}T00:00:00Z`));
  const streak = history.longestStreak;
  return <>
    <ListRow title={copy.lifetimeTokens} meta={compactTokens(history.lifetimeTokens, locale)} />
    <ListRow title={copy.busiestDay} meta={history.busiestDay ? compactTokens(history.busiestDay.tokens, locale) : "—"}
      description={history.busiestDay ? date(history.busiestDay.date) : undefined} />
    <ListRow title={copy.longestTask} meta={history.longestTask ? durationMinutes(history.longestTask.durationMs / 60000, copy) : "—"} description={history.longestTask?.title ?? undefined} />
    <ListRow title={copy.longestStreak} meta={copy.days(Math.round(streak.days))} description={streak.start && streak.end ? `${date(streak.start)} – ${date(streak.end)}` : undefined} />
    <ListRow title={copy.currentStreak} meta={copy.days(Math.round(history.currentStreak.days))} />
  </>;
}

function UsageImages({ revision }: { revision: number }) {
  const app = getAppCopy(useAppLocale()), copy = app.composer.usage;
  const { client, reconcile } = useConversation();
  const [days, setDays] = useState("7"), [retry, setRetry] = useState(0);
  const [snapshot, setSnapshot] = useState<{ selected: unknown | null; views: ImageUsageView[] }>();
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setError(false);
    void Promise.all([client.request<ImageUsageSelection>("/settings/image-model"),
      Promise.all([...new Set([30, Number(days)])].map(range => client.request<ImageUsageView>(`/usage/images?days=${range}`)))])
      .then(([settings, views]) => { if (!cancelled) setSnapshot({ selected: settings.selected, views }); }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [client, days, revision, reconcile, retry]);
  const view = snapshot?.views.find(v => v.days === Number(days));
  useEffect(() => {
    if (error && view) showToast({ message: app.interfacePanels.usageFailed, tone: "error" });
  }, [error, view, app.interfacePanels.usageFailed]);
  if (!snapshot || (snapshot.selected === null && !snapshot.views.find(v => v.days === 30)?.models.length)) return null;
  return <SettingsGroup title={copy.imagesTitle}>
    <SelectRow title={copy.period} value={days} options={[{ value: "7", label: copy.week }, { value: "30", label: copy.month }]} onSelect={setDays} />
    {!view ? <GroupInset><LoadState error={error} message={app.interfacePanels.usageFailed} onRetry={() => setRetry(n => n + 1)} /></GroupInset> : <>
      {view.models.map(model => <ImageUsageRow key={model.model_ref} title={model.display_name} values={model} />)}
      <ImageUsageRow title={copy.imagesTotal} values={view.total} />
    </>}
  </SettingsGroup>;
}

function ImageUsageRow({ title, values }: { title: string; values: ImageUsageValues }) {
  const locale = useAppLocale(), copy = getAppCopy(locale).composer.usage;
  const cost = values.estimated_usd, count = new Intl.NumberFormat(locale);
  const price = cost === null ? "—" : cost > 0 && cost < 0.005 ? "<$0.01" : new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cost);
  return <ListRow title={title} description={`${copy.imagesGenerated} ${count.format(values.generated)} · ${copy.imagesEdited} ${count.format(values.edited)}`} meta={price} />;
}

function windowLabel(window: ProviderQuotaResultView["windows"][number], app: AppCopy) {
  if (window.id === "mcp-month") return app.interfaceStatus.mcpMonthly;
  if (window.id === "tokens-5-hour" || window.id.startsWith("tokens-5-hour-")) return app.interfaceStatus.fiveHour;
  if (window.id === "tokens-weekly" || window.id.startsWith("tokens-weekly-")) return app.interfaceStatus.weekly;
  if (window.windowDurationMins !== null) return app.interfaceStatus.minutesLimit(window.windowDurationMins);
  return window.id === "individualLimit" ? app.interfaceStatus.individual : app.interfaceStatus.providedLimit;
}

function UsageProvider({ provider }: { provider: UsageMonitorView["providerUsage"]["providers"][number] }) {
  const locale = useAppLocale(), app = getAppCopy(locale), copy = app.composer.usage;
  const { catalog } = useModelCatalog();
  const name = catalog?.providers.find(p => p.provider_id === provider.providerId)?.provider_label
    ?? catalog?.models.find(m => m.provider_id === provider.providerId)?.provider_label
    ?? provider.providerId.split(/[-_\s]+/u).filter(Boolean).map(w => w.charAt(0).toLocaleUpperCase() + w.slice(1)).join(" ");
  const quota = provider.remaining;
  const payAsYouGo = quota.planKind === "api" && quota.reason?.code === "provider_quota_not_offered";
  const failed = quota.stale || (!quota.available && !payAsYouGo);
  const plan = quota.planName || (quota.planKind === "subscription" ? app.interfaceStatus.subscription : quota.planKind === "api" ? app.interfaceStatus.apiUsage : app.interfaceStatus.unconfirmed);
  const timestamp = quota.fetchedAt ? Date.parse(quota.fetchedAt) : NaN;
  const age = Number.isFinite(timestamp) ? copy.elapsedMinutes(Math.max(0, Math.floor((Date.now() - timestamp) / 60000))) : undefined;
  const windows = quota.planUsage?.state === "limit_reached" && !quota.windows.length
    ? [{ id: "individualLimit", remainingPercent: 0, windowDurationMins: null, resetsAt: quota.planUsage.resetsAt, expiresAt: null }] : quota.windows;
  return <Fragment>
    <ListRow title={name} description={payAsYouGo ? copy.payAsYouGo : plan} meta={age ? failed ? copy.refreshFailedStale(age) : copy.checkedAgo(age) : undefined} />
    {payAsYouGo ? <ListRow title={copy.thisMonth} meta={compactTokens(provider.monthTokens ?? 0, locale)} />
      : windows.map(window => <QuotaWindow key={window.id} window={window} />)}
  </Fragment>;
}

function QuotaWindow({ window }: { window: ProviderQuotaResultView["windows"][number] }) {
  const app = getAppCopy(useAppLocale()), copy = app.composer.usage;
  const remaining = window.remainingPercent === null || !Number.isFinite(window.remainingPercent) ? null : Math.max(0, Math.min(100, window.remainingPercent));
  const reset = window.resetsAt ?? window.expiresAt, resetMs = reset ? Date.parse(reset) : NaN;
  const relative = Number.isFinite(resetMs) ? durationMinutes(Math.max(0, Math.ceil((resetMs - Date.now()) / 60000)), copy) : null;
  const caption = remaining === 0 ? relative ? copy.limitResetsIn(relative) : copy.limitReached : relative ? copy.resetsIn(relative) : undefined;
  return <ListRow title={windowLabel(window, app)} meta={remaining === null ? app.interfaceStatus.unknown : `${Math.round(remaining)}%`} description={caption} />;
}
