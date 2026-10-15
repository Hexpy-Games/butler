import { useEffect, useState } from "react";
import { api } from "@/app/api";
import { appCopy } from "@/app/copy";
import type { UsageMonitorView } from "@/app/types";
import { SettingsSection } from "./SettingsFormComponents";
import { UsageSectionPanel } from "./UsageSectionPanel";

/** Prompt section estimates are diagnostics, separate from consumer usage. */
export function DeveloperUsageSections() {
  const [view, setView] = useState<UsageMonitorView | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api<UsageMonitorView>("/usage-monitor?since_hours=24").then(next => {
      if (!cancelled) setView(next);
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);
  const rows = Object.entries(view?.model.bySection ?? {}).sort((a, b) => b[1].estimatedTokens - a[1].estimatedTokens);
  return <SettingsSection id="developer-context-estimates" kind="list" title={appCopy.interfaceDetails.contextEstimates}
    description={appCopy.composer.usage.day} state={!view ? failed ? "error" : "loading" : rows.length ? "ready" : "empty"}
    errorMessage={appCopy.interfacePanels.usageFailed} emptyMessage={appCopy.composer.usage.noUsage}>
    <UsageSectionPanel rows={rows} />
  </SettingsSection>;
}
