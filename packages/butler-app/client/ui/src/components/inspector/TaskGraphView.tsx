import { useMemo } from "react";
import type { TaskGraphNode, TaskGraphSnapshot } from "@/app/taskGraphApi.ts";
import { TaskGraphCanvas, TaskGraphCard, TaskGraphSection } from "@/butler-ds";
import { graphAssignee, graphMeta, graphElapsed, graphTaskStatus, graphStatusLabel } from "./taskGraphPresentation.ts";
import { TaskNodeDetail } from "./TaskNodeDetail.tsx";
import { useTaskGraphClock } from "./useTaskGraphClock.ts";

export function TaskGraphView({ graph, selected, open, single, visible, onToggle, onSelect, onOpenDocument, onOpenSession }: {
  graph: TaskGraphSnapshot; selected: string | null; open: boolean; single: boolean; visible: boolean;
  onToggle: () => void; onSelect: (id: string) => void;
  onOpenDocument: (node: TaskGraphNode) => void; onOpenSession: (sessionId: string) => void;
}) {
  const nodes = useMemo(() => graph.nodes.map(n => ({ id: n.task_id, status: graphTaskStatus(n) })), [graph.nodes]);
  const byId = useMemo(() => new Map(graph.nodes.map(n => [n.task_id, n])), [graph.nodes]);
  const running = useMemo(() => graph.nodes.some(n => n.status === "running"), [graph.nodes]);
  const now = useTaskGraphClock(running, visible);
  const status = graph.work_state === "blocked" ? "blocked" : graph.state === "waiting" ? "pending" : graph.state;
  const selectedNode = selected ? byId.get(selected) : undefined;
  const activate = (id: string) => {
    onSelect(id);
    const sessionId = byId.get(id)?.session_id;
    if (sessionId) onOpenSession(sessionId);
  };
  return <TaskGraphSection graphId={graph.graph_id} title={graph.title} status={status} meta={graphMeta(graph)}
    collapsible={!single} open={open} onToggle={onToggle}>
    <TaskGraphCanvas nodes={nodes} edges={graph.edges} orientation="auto" label={graph.title} selectedId={selected} onSelect={onSelect}
      renderNode={id => {
        const node = byId.get(id)!;
        const status = graphTaskStatus(node);
        return <TaskGraphCard taskId={id} title={node.title} status={status} statusLabel={graphStatusLabel(node)}
          meta={[graphAssignee(node), node.model_display_name].filter(Boolean).join(" · ")} time={graphElapsed(node, now)}
          step={node.current_step ?? undefined} selected={id === selected} opensDialog={Boolean(node.session_id)} onActivate={activate} />;
      }} />
    {selectedNode && <TaskNodeDetail node={selectedNode} graph={graph} now={now} onSelect={onSelect}
      onOpenDocument={onOpenDocument} onOpenSession={onOpenSession} />}
  </TaskGraphSection>;
}
