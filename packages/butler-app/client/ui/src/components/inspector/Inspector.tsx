import { useAppLocale } from "@/app/copy.ts";
import type { ReactElement } from "react";
import {
  Blocks,
  Clock3,
  Command,
  FileText,
  ListFilter,
  InspectorShell,
} from "@/butler-ds";
import { useButlerStore, selectEffectiveRightOpen } from "@/app/store.ts";
import { appCopy } from "@/app/copy.ts";
import { useDeveloperMode } from "@/hooks/useDeveloperMode.ts";
import { SummaryPanel } from "./SummaryPanel.tsx";
import { ContextPanel } from "./ContextPanel.tsx";
import { ArtifactsPanel } from "./ArtifactsPanel.tsx";
import { AutomationTargetsPanel } from "./AutomationTargetsPanel.tsx";
import { WorkersPanel } from "./WorkersPanel.tsx";

interface InspectorProps {
  id?: string;
}

/** Agent-internal tabs that only developer mode shows. */
const DEVELOPER_TABS: ReadonlySet<string> = new Set(["context", "workers"]);

/** The tab to show: a saved developer tab falls back to Summary outside developer mode. */
export function visibleInspectorTab(tab: string, developerMode: boolean): string {
  return developerMode || !DEVELOPER_TABS.has(tab) ? tab : "summary";
}

export function Inspector({ id }: InspectorProps = {}) {
  useAppLocale();
  const status = useButlerStore((state) => state.status);
  const summary = useButlerStore((state) => state.summary);
  const developerMode = useDeveloperMode();
  const activeTab = visibleInspectorTab(
    useButlerStore((state) => state.rightTab),
    developerMode,
  );
  const setRightTab = useButlerStore((state) => state.setRightTab);
  const setView = useButlerStore((state) => state.setView);
  const controlWorker = useButlerStore((state) => state.controlWorker);
  const isOpen = useButlerStore(selectEffectiveRightOpen);

  const tabs: Array<[string, string, ReactElement]> = [
    ["summary", appCopy.inspector.tabs.summary, <ListFilter size="md" />],
    ["context", appCopy.inspector.tabs.context, <Command size="md" />],
    ["artifacts", appCopy.inspector.tabs.artifacts, <FileText size="md" />],
    ["automations", appCopy.inspector.tabs.automations, <Clock3 size="md" />],
    ["workers", appCopy.inspector.tabs.workers, <Blocks size="md" />],
  ];

  return (
    <InspectorShell
      activeTab={activeTab}
      id={id}
      open={isOpen}
      tabs={tabs
        .filter(([id]) => visibleInspectorTab(id, developerMode) === id)
        .map(([id, label, icon]) => ({ id, label, icon }))}
      onTabChange={setRightTab}
    >
      {activeTab === "summary" && (
        <SummaryPanel
          developerMode={developerMode}
          status={status}
          summary={summary}
        />
      )}
      {activeTab === "context" && (
        <ContextPanel context={summary?.context_details} />
      )}
      {activeTab === "artifacts" && (
        <ArtifactsPanel artifacts={summary?.artifacts ?? []} />
      )}
      {activeTab === "automations" && (
        <AutomationTargetsPanel
          automations={summary?.automation_targets ?? []}
          onOpenAutomation={(automationId) =>
            setView({ kind: "automation-detail", automationId })
          }
        />
      )}
      {activeTab === "workers" && (
        <WorkersPanel
          workers={summary?.worker_activity ?? []}
          onWorkerControl={controlWorker}
        />
      )}
    </InspectorShell>
  );
}
