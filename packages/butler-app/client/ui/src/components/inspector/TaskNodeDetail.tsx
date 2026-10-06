import { appCopy } from "@/app/copy.ts";
import type { TaskGraphNode, TaskGraphSnapshot } from "@/app/taskGraphApi.ts";
import { TaskGraphDetail, TaskGraphStepLine } from "@/butler-ds";
import { graphAssignee, graphElapsed, graphTaskStatus } from "./taskGraphPresentation.ts";

export function TaskNodeDetail({ node, graph, now, onSelect, onOpenDocument, onOpenSession }: {
  node: TaskGraphNode; graph: TaskGraphSnapshot; now: number;
  onSelect: (id: string) => void;
  onOpenDocument: (node: TaskGraphNode) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const c = appCopy.taskGraph;
  const status = graphTaskStatus(node);
  const nodes = new Map(graph.nodes.map(n => [n.task_id, n]));
  const related = (before: boolean) => graph.edges.filter(e => (before ? e.to : e.from) === node.task_id)
    .flatMap(e => { const n = nodes.get(before ? e.from : e.to); return n ? [{ id: n.task_id, title: n.title }] : []; });
  const notice = status === "blocked" ? { tone: "warning" as const, message: c.blockedByFailure }
    : status === "failed" && node.blocked_reason ? { tone: "error" as const, message: node.blocked_reason } : undefined;
  return <TaskGraphDetail title={node.title} status={status} statusLabel={c.status[status]} notice={notice}
    facts={[
      { id: "assignee", label: c.detail.assignee, value: graphAssignee(node) },
      { id: "model", label: c.detail.model, value: node.model_display_name ?? c.detail.none },
      { id: "elapsed", label: c.detail.elapsed, value: graphElapsed(node, now) ?? c.detail.none },
      ...(status === "running" && node.current_step ? [{ id: "step", label: c.detail.step, value: <TaskGraphStepLine step={node.current_step} /> }] : []),
    ]}
    relations={[
      { id: "after", label: c.detail.after, tasks: related(true), emptyLabel: c.detail.none },
      { id: "next", label: c.detail.next, tasks: related(false), emptyLabel: c.detail.none },
    ]} onSelectTask={onSelect}
    document={{ title: node.document.title, meta: node.document.id.startsWith("TASK-") ? `${node.document.id} · ${c.status[status]}` : c.status[status],
      ariaLabel: c.detail.document, actionLabel: c.detail.openDocument, onOpen: () => onOpenDocument(node) }}
    conversation={node.session_id ? { label: c.detail.conversation, onOpen: () => onOpenSession(node.session_id!) } : undefined}
  />;
}
