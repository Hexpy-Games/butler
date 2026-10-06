import { useMemo } from "react";
import { appCopy } from "@/app/copy.ts";
import type { TaskGraphNode, TaskGraphSnapshot } from "@/app/taskGraphApi.ts";
import { TaskGraphCanvas, TaskGraphCard, TaskGraphSection, rollupTaskGraphStatus } from "@/butler-ds";
import { graphAssignee, graphCounts, graphElapsed, graphTaskStatus } from "./taskGraphPresentation.ts";
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
  const status = useMemo(() => rollupTaskGraphStatus(nodes.map(n => n.status)), [nodes]);
  const selectedNode = selected ? byId.get(selected) : undefined;
  const activate = (id: string) => {
    onSelect(id);
    const sessionId = byId.get(id)?.session_id;
    if (sessionId) onOpenSession(sessionId);
  };
  return <TaskGraphSection graphId={graph.graph_id} title={graph.title} status={status} meta={graphCounts(graph)}
    collapsible={!single} open={open} onToggle={onToggle}>
    <TaskGraphCanvas nodes={nodes} edges={graph.edges} orientation="auto" label={graph.title} selectedId={selected} onSelect={onSelect}
      renderNode={id => {
        const node = byId.get(id)!;
        const status = graphTaskStatus(node);
        return <TaskGraphCard taskId={id} title={node.title} status={status} statusLabel={appCopy.taskGraph.status[status]}
          meta={[graphAssignee(node), node.model_display_name].filter(Boolean).join(" · ")} time={graphElapsed(node, now)}
          step={node.current_step ?? undefined} selected={id === selected} opensDialog={Boolean(node.session_id)} onActivate={activate} />;
      }} />
    {selectedNode && <TaskNodeDetail node={selectedNode} graph={graph} now={now} onSelect={onSelect}
      onOpenDocument={onOpenDocument} onOpenSession={onOpenSession} />}
  </TaskGraphSection>;
}
