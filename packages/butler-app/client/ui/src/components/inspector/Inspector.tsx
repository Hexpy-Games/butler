import type { ReactElement } from "react";
import {
  Blocks,
  Clock3,
  Command,
  FileText,
  ListFilter,
  ListChecks,
  InspectorShell,
} from "@/butler-ds";
import { useButlerStore, selectEffectiveRightOpen } from "@/app/store.ts";
import { appCopy } from "@/app/copy.ts";
import { SummaryPanel } from "./SummaryPanel.tsx";
import { ContextPanel } from "./ContextPanel.tsx";
import { ArtifactsPanel } from "./ArtifactsPanel.tsx";
import { AutomationTargetsPanel } from "./AutomationTargetsPanel.tsx";
import { WorkersPanel } from "./WorkersPanel.tsx";
import { TurnActivityLogPanel } from "./TurnActivityLogPanel.tsx";

interface InspectorProps {
  id?: string;
}

export function Inspector({ id }: InspectorProps = {}) {
  const status = useButlerStore((state) => state.status);
  const summary = useButlerStore((state) => state.summary);
  const activeTab = useButlerStore((state) => state.rightTab);
  const setRightTab = useButlerStore((state) => state.setRightTab);
  const setView = useButlerStore((state) => state.setView);
  const controlWorker = useButlerStore((state) => state.controlWorker);
  const exportTranscript = useButlerStore((state) => state.exportTranscript);
  const isOpen = useButlerStore(selectEffectiveRightOpen);

  const tabs: Array<[string, string, ReactElement]> = [
    ["summary", appCopy.inspector.tabs.summary, <ListFilter size={16} />],
    ["activity", appCopy.inspector.tabs.activity, <ListChecks size={16} />],
    ["context", appCopy.inspector.tabs.context, <Command size={16} />],
    ["artifacts", appCopy.inspector.tabs.artifacts, <FileText size={16} />],
    ["automations", appCopy.inspector.tabs.automations, <Clock3 size={16} />],
    ["workers", appCopy.inspector.tabs.workers, <Blocks size={16} />],
  ];

  return (
    <InspectorShell
      activeTab={activeTab}
      id={id}
      open={isOpen}
      tabs={tabs.map(([id, label, icon]) => ({ id, label, icon }))}
      onTabChange={setRightTab}
    >
      {activeTab === "summary" && (
        <SummaryPanel
          status={status}
          summary={summary}
          onExportTranscript={exportTranscript}
        />
      )}
      {activeTab === "activity" && (
        <TurnActivityLogPanel
          rows={summary?.latest_progress?.safe_progress_rows ?? []}
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
