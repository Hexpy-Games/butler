import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import type { UsageMonitorView } from "@/app/types.ts";
import { Button, Stack, Typo } from "@/butler-ds";
import { SettingsSection } from "./SettingsSection";
import { UsageBucketPanel } from "./UsageBucketPanel";
import { UsageMonitorMetrics } from "./UsageMonitorMetrics";
import { UsageProviderPanel } from "./UsageProviderPanel";
import { UsageToolPanel } from "./UsageToolPanel";
import { formatTimestamp, usageRows } from "./usageSettingsFormat";

const RANGE_OPTIONS = [
  { id: "24h", label: "24시간", hours: 24 },
  { id: "7d", label: "7일", hours: 24 * 7 },
  { id: "all", label: "전체", hours: null },
] as const;

type UsageRange = (typeof RANGE_OPTIONS)[number]["id"];

export function UsageSettings() {
  const [range, setRange] = useState<UsageRange>("24h");
  const [view, setView] = useState<UsageMonitorView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = RANGE_OPTIONS.find((item) => item.id === range)!;

  const refresh = useCallback(async () => {
    const params = new URLSearchParams();
    if (selected.hours !== null) params.set("since_hours", String(selected.hours));
    setLoading(true);
    setError(null);
    try {
      const query = params.toString();
      setView(await api<UsageMonitorView>(query ? `/usage-monitor?${query}` : "/usage-monitor"));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Usage monitor failed.");
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
  const toolRows = useMemo(
    () =>
      Object.entries(view?.tools.byTool ?? {})
        .sort((left, right) => right[1].calls - left[1].calls)
        .slice(0, 8),
    [view],
  );
  const providerUsage = view?.providerUsage;

  return (
    <SettingsSection
      title={appCopy.settings.panels.usageMonitor}
      description={appCopy.settings.descriptions.usageMonitor}
    >
      <Stack gap="lg">
        <Stack
          align="row"
          justify="between"
          gap="md"
          wrap
        >
          <Stack align="row" gap="xs" wrap>
            {RANGE_OPTIONS.map((option) => (
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
          </Stack>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {appCopy.common.refresh}
          </Button>
        </Stack>

        {error && <Typo.Body>{error}</Typo.Body>}

        <UsageMonitorMetrics view={view} />

        <UsageProviderPanel
          activeProviderId={providerUsage?.activeProviderId ?? null}
          providers={providerUsage?.providers ?? []}
        />
        <UsageBucketPanel title="스코프별 토큰" rows={scopeRows} />
        <UsageBucketPanel title="모델별 토큰" rows={modelRows} />
        <UsageToolPanel rows={toolRows} />
        <Typo.Caption>
          {view?.generated_at ? `${formatTimestamp(view.generated_at)} · ` : ""}
          raw text excluded
        </Typo.Caption>
      </Stack>
    </SettingsSection>
  );
}
