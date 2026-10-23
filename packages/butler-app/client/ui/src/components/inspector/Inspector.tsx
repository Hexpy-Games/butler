import { useEffect } from "react";
import { useActiveCanonEpic } from "../canon/useActiveCanonEpic.ts";
import { EpicInspector } from "../canon/EpicInspector.tsx";
import { ErrorBoundary } from "@/components/common/ErrorBoundary.tsx";
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
import { TasksPanel } from "./TasksPanel.tsx";
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
  const epic = useActiveCanonEpic();
  const sessionId = useButlerStore(state => state.activeChatId);
  const savedTab = visibleInspectorTab(
    useButlerStore((state) => state.rightTab),
    developerMode,
  );
  const activeTab = savedTab === "epic" && !epic ? "summary" : epic && savedTab === "automations" ? "epic" : savedTab;
  const setRightTab = useButlerStore((state) => state.setRightTab);
  const setView = useButlerStore((state) => state.setView);
  const controlWorker = useButlerStore((state) => state.controlWorker);
  const isOpen = useButlerStore(selectEffectiveRightOpen);
  const view = useButlerStore(state => state.view);
  const dashboardEpic = view.kind === "project-dashboard" && view.epicId ? view : null;

  useEffect(() => { if (epic) setRightTab("epic"); }, [sessionId, epic?.epic.id, setRightTab]);

  const tabs: Array<[string, string, ReactElement]> = [
    ["summary", appCopy.inspector.tabs.summary, <ListFilter size="md" />],
    ["tasks", appCopy.inspector.tabs.tasks, <Blocks size="md" />],
    ["context", appCopy.inspector.tabs.context, <Command size="md" />],
    ["artifacts", appCopy.inspector.tabs.artifacts, <FileText size="md" />],
    ["automations", appCopy.inspector.tabs.automations, <Clock3 size="md" />],
    ["workers", appCopy.inspector.tabs.workers, <Blocks size="md" />],
  ];
  if (epic) {
    tabs.unshift(["epic", appCopy.canon.epic, <FileText size="md" />]);
    tabs.splice(tabs.findIndex(([id]) => id === "automations"), 1);
  }

  if (dashboardEpic) return <InspectorShell activeTab="epic" id={id} open={isOpen} onTabChange={setRightTab}
    tabs={[{ id: "epic", label: appCopy.canon.epic, icon: <FileText size="md" /> }]}>
    <ErrorBoundary key={dashboardEpic.epicId} scope="inspector-epic">
      <EpicInspector focusTitle key={dashboardEpic.epicId} projectId={dashboardEpic.projectId} epicId={dashboardEpic.epicId!} />
    </ErrorBoundary>
  </InspectorShell>;

  return <InspectorShell activeTab={activeTab} id={id} open={isOpen} onTabChange={setRightTab}
    tabs={tabs.filter(([id]) => visibleInspectorTab(id, developerMode) === id).map(([id, label, icon]) => ({ id, label, icon }))}>
    <ErrorBoundary key={activeTab} scope={`inspector-${activeTab}`}>
      {activeTab === "epic" && epic && <EpicInspector key={epic.epic.id} projectId={epic.projectId} epicId={epic.epic.id} />}
      {activeTab === "summary" && <SummaryPanel developerMode={developerMode} status={status} summary={summary} />}
      {activeTab === "tasks" && <TasksPanel />}
      {activeTab === "context" && <ContextPanel context={summary?.context_details} />}
      {activeTab === "artifacts" && <ArtifactsPanel artifacts={summary?.artifacts ?? []} />}
      {activeTab === "automations" && <AutomationTargetsPanel automations={summary?.automation_targets ?? []}
        onOpenAutomation={automationId => setView({ kind: "automation-detail", automationId })} />}
      {activeTab === "workers" && <WorkersPanel workers={summary?.worker_activity ?? []} onWorkerControl={controlWorker} />}
    </ErrorBoundary>
  </InspectorShell>;
}
