import { useAppLocale } from "@/app/copy.ts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import type { UsageMonitorView } from "@/app/types.ts";
import { Button, ButtonContainer, Stack, type SettingsSectionState } from "@/butler-ds";
import { SettingsPage, SettingsSection } from "./SettingsFormComponents";
import { UsageBucketPanel } from "./UsageBucketPanel";
import { UsageMonitorMetrics } from "./UsageMonitorMetrics";
import { UsageProviderPanel } from "./UsageProviderPanel";
import { UsageSectionPanel } from "./UsageSectionPanel";
import { UsageToolPanel } from "./UsageToolPanel";
import { formatTimestamp, usageRows } from "./usageSettingsFormat";

const rangeOptions = () => [
  { id: "24h", label: appCopy.interfaceDetails.day, hours: 24 },
  { id: "7d", label: appCopy.interfaceDetails.week, hours: 24 * 7 },
  { id: "all", label: appCopy.interfaceDetails.all, hours: null },
] as const;

type UsageRange = ReturnType<typeof rangeOptions>[number]["id"];

export function UsageSettings() {
  useAppLocale();
  const [range, setRange] = useState<UsageRange>("24h");
  const [view, setView] = useState<UsageMonitorView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const selected = rangeOptions().find((item) => item.id === range)!;

  const refresh = useCallback(async () => {
    const params = new URLSearchParams();
    if (selected.hours !== null) params.set("since_hours", String(selected.hours));
    setLoading(true);
    setError(false);
    try {
      const query = params.toString();
      setView(await api<UsageMonitorView>(query ? `/usage-monitor?${query}` : "/usage-monitor"));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [selected.hours]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const scopeRows = useMemo(
    () => usageRows(view?.model.byScopeUsage ?? {}),
    [view],
  );
  const modelRows = useMemo(() => usageRows(view?.model.byModel ?? {}), [view]);
  const sectionRows = useMemo(
    () =>
      Object.entries(view?.model.bySection ?? {})
        .sort((left, right) =>
          right[1].estimatedTokens - left[1].estimatedTokens ||
          right[1].chars - left[1].chars ||
          left[0].localeCompare(right[0]),
        )
        .slice(0, 12),
    [view],
  );
  const toolRows = useMemo(
    () =>
      Object.entries(view?.tools.byTool ?? {})
        .sort((left, right) => right[1].calls - left[1].calls)
        .slice(0, 8),
    [view],
  );
  const providerUsage = view?.providerUsage;

  const copy = appCopy.interfaceDetails;
  const empty = appCopy.settings.descriptions.usageMonitorEmpty;
  const listState = (count: number): SettingsSectionState =>
    view === null ? (error ? "error" : "loading") : count === 0 ? "empty" : "ready";
  const listProps = (count: number) => ({
    kind: "list" as const,
    state: listState(count),
    emptyMessage: empty,
    errorMessage: appCopy.interfacePanels.usageFailed,
    onRetry: () => void refresh(),
  });

  return (
    <SettingsPage>
      <SettingsSection
        id="usage-overview"
        kind="status"
        title={appCopy.settings.pageSections.usageOverview}
        description={[
          appCopy.settings.descriptions.usageMonitor,
          view?.generated_at ? formatTimestamp(view.generated_at) : null,
        ].filter(Boolean).join(" · ")}
        state={view === null ? (error ? "error" : "loading") : "ready"}
        errorMessage={appCopy.interfacePanels.usageFailed}
        onRetry={() => void refresh()}
        actions={
          <Stack align="row" gap="sm" wrap>
            <ButtonContainer size="sm">
              {rangeOptions().map((option) => (
                <Button
                  key={option.id}
                  type="button"
                  size="sm"
                  variant={range === option.id ? "default" : "outline"}
                  aria-pressed={range === option.id}
                  onClick={() => setRange(option.id)}
                >
                  {option.label}
                </Button>
              ))}
            </ButtonContainer>
            <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => void refresh()}>
              {appCopy.common.refresh}
            </Button>
          </Stack>
        }
      >
        <UsageMonitorMetrics view={view} />
      </SettingsSection>
      <SettingsSection
        id="usage-providers"
        title={copy.apiProviderUsage}
        description={providerUsage?.activeProviderId
          ? appCopy.interfaceTemplates.activeProvider(providerUsage.activeProviderId)
          : undefined}
        {...listProps(providerUsage?.providers.length ?? 0)}
      >
        <UsageProviderPanel providers={providerUsage?.providers ?? []} />
      </SettingsSection>
      <SettingsSection id="usage-scope-tokens" title={copy.scopeTokens} {...listProps(scopeRows.length)}>
        <UsageBucketPanel rows={scopeRows} />
      </SettingsSection>
      <SettingsSection id="usage-model-tokens" title={copy.modelTokens} {...listProps(modelRows.length)}>
        <UsageBucketPanel rows={modelRows} />
      </SettingsSection>
      <SettingsSection id="usage-prompt-sections" title={copy.contextEstimates} {...listProps(sectionRows.length)}>
        <UsageSectionPanel rows={sectionRows} />
      </SettingsSection>
      <SettingsSection id="usage-tools" title={copy.callsByTool} {...listProps(toolRows.length)}>
        <UsageToolPanel rows={toolRows} />
      </SettingsSection>
    </SettingsPage>
  );
}
