import { useEffect, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { sessionFromNavigation } from "@/app/utils.ts";
import { useButlerStore, selectEffectiveRightOpen } from "@/app/store.ts";
import { EMPTY_TASK_GRAPHS, loadTaskGraphs, observeTaskGraphs, useTaskGraphs } from "@/app/taskGraphState.ts";
import { getTaskDocument, type TaskGraphDocument, type TaskGraphNode } from "@/app/taskGraphApi.ts";
import { notifyStatus } from "@/app/notifications.ts";
import { Blocks, Button, InspectorInset, TaskGraphPanel } from "@/butler-ds";
import { ProjectDocumentDialog } from "@/components/management/ProjectDocumentDialog.tsx";
import { TaskGraphView } from "./TaskGraphView.tsx";
import { graphCounts } from "./taskGraphPresentation.ts";

export function TasksPanel() {
  useAppLocale();
  const sessionId = useButlerStore(state => state.activeChatId);
  return <SessionTasksPanel key={sessionId} sessionId={sessionId} />;
}

function SessionTasksPanel({ sessionId }: { sessionId: string }) {
  const runtimeId = useButlerStore(s => sessionFromNavigation(s.navigation, sessionId)?.session_hint ?? sessionId);
  const visible = useButlerStore(selectEffectiveRightOpen);
  const onOpenSession = useButlerStore(state => state.openSessionObserver);
  const state = useTaskGraphs(s => s.taskGraphs[sessionId] ?? EMPTY_TASK_GRAPHS);
  const update = useTaskGraphs(s => s.update);
  const [document, setDocument] = useState<TaskGraphDocument | null>(null);
  useEffect(() => visible ? observeTaskGraphs(sessionId, runtimeId) : undefined, [sessionId, runtimeId, visible]);
  const c = appCopy.taskGraph;
  const single = state.graphs.length === 1 ? state.graphs[0] : undefined;
  const onSelect = (selected: string) => update(sessionId, { selected, selectionExplicit: true });
  const onOpenDocument = async (node: TaskGraphNode) => {
    try { setDocument(await getTaskDocument(node.task_id, node.document.revision)); }
    catch { notifyStatus(appCopy.settings.sectionState.error, { tone: "error" }); }
  };
  return <>
    <TaskGraphPanel title={c.title} icon={<Blocks size="md" />} description={single?.title}
      empty={state.graphs.length === 0} emptyLabel={state.loading ? appCopy.settings.sectionState.loading : state.error ? appCopy.settings.sectionState.error : c.empty}
      headerMeta={single ? graphCounts(single) : state.graphs.length ? c.graphsSummary(state.graphs.length, state.graphs.filter(g => g.state === "running").length) : undefined}>
      {state.graphs.map(graph => <TaskGraphView key={graph.graph_id} graph={graph} selected={state.selected}
        single={Boolean(single)} open={Boolean(state.open[graph.graph_id])} visible={visible}
        onToggle={() => update(sessionId, { open: { ...state.open, [graph.graph_id]: !state.open[graph.graph_id] } })}
        onSelect={onSelect} onOpenSession={onOpenSession} onOpenDocument={onOpenDocument} />)}
    </TaskGraphPanel>
    {state.error && <InspectorInset><Button size="sm" variant="outline" onClick={() => void loadTaskGraphs(sessionId)}>
      {appCopy.settings.sectionState.retry}
    </Button></InspectorInset>}
    <ProjectDocumentDialog document={document} onClose={() => setDocument(null)} />
  </>;
}
