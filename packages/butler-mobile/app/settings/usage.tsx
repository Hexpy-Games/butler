import { Fragment, useEffect, useState } from "react";
import { getAppCopy, type AppCopy } from "../../../butler-i18n/src/index.ts";
import { useConversation } from "@/conversation/live";
import { Button, ListGroup, ListGroupItem, ListRow, Text } from "@/ds";
import { useAppLocale } from "@/i18n";
import { LoadState, SettingsScreen } from "@/settings/layout";
import { SelectRow } from "@/settings/rows";
import { compactTokens } from "@/settings/format";
import { useModelCatalog } from "@/settings/useModelCatalog";
import type { ProviderQuotaResultView, UsageMonitorView } from "@/settings/types";

export default function UsageSettings() {
  const app = getAppCopy(useAppLocale()), S = app.settings, usage = app.composer.usage;
  const { client, reconcile } = useConversation();
  const [hours, setHours] = useState("24"), [revision, refresh] = useState(0);
  const [view, setView] = useState<UsageMonitorView | null>(null);
  const [error, setError] = useState(false), [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setLoading(true); setError(false); setView(null);
    void client.request<UsageMonitorView>(`/usage-monitor?since_hours=${hours}`).then(next => { if (!cancelled) setView(next); })
      .catch(() => { if (!cancelled) setError(true); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [client, hours, revision, reconcile]);
  const reload = () => refresh(n => n + 1);
  return <SettingsScreen title={S.sections.usage}>
    <ListGroup label={usage.overviewTitle}>
      <SelectRow title={usage.period} value={hours} options={[{ value: "24", label: usage.day }, { value: "168", label: usage.week }, { value: "720", label: usage.month }]} onSelect={setHours} />
      <ListGroupItem><Button label={app.common.refresh} disabled={loading} onPress={reload} /></ListGroupItem>
      {!view ? <LoadState error={error} message={app.interfacePanels.usageFailed} onRetry={reload} /> : <UsageOverview view={view} />}
    </ListGroup>
    {view?.providerUsage.providers.length ? <ListGroup label={usage.remaining}>
      {view.providerUsage.providers.map(provider => <UsageProvider key={provider.providerId} provider={provider} />)}
    </ListGroup> : null}
  </SettingsScreen>;
}

function UsageOverview({ view }: { view: UsageMonitorView }) {
  const locale = useAppLocale(), usage = getAppCopy(locale).composer.usage, model = view.model;
  const cost = view.cost.available ? view.cost.estimatedUsd : null;
  const costText = !cost ? "—" : cost < 0.01 ? usage.tinyCost : new Intl.NumberFormat(locale, { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol" }).format(cost);
  const ratio = model.promptTokens ? Math.round(model.cachedTokens / model.promptTokens * 100) : 0;
  return <>
    <ListGroupItem>
      <Text variant="h2">{compactTokens(model.totalTokens, locale)}</Text>
      <Text variant="caption">{usage.tokens}</Text>
    </ListGroupItem>
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
  const timestamp = quota.fetchedAt ? Date.parse(quota.fetchedAt) : NaN;
  const age = Number.isFinite(timestamp) ? copy.elapsedMinutes(Math.max(0, Math.floor((Date.now() - timestamp) / 60000))) : undefined;
  const windows = quota.planUsage?.state === "limit_reached" && !quota.windows.length
    ? [{ id: "individualLimit", remainingPercent: 0, windowDurationMins: null, resetsAt: quota.planUsage.resetsAt, expiresAt: null }] : quota.windows;
  return <Fragment>
    <ListRow title={name} meta={age ? failed ? copy.refreshFailedStale(age) : copy.checkedAgo(age) : undefined} />
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
