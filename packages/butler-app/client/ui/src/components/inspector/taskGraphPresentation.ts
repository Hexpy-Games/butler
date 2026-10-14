import { appCopy } from "@/app/copy.ts";
import type { TaskGraphNode, TaskGraphSnapshot } from "@/app/taskGraphApi.ts";
import type { TaskGraphStatus } from "@/butler-ds";

export function graphTaskStatus(node: TaskGraphNode): TaskGraphStatus {
  if (node.status === "skipped") return "done";
  return node.status;
}
export function graphCounts(graph: TaskGraphSnapshot): string {
  const c = appCopy.taskGraph;
  // A skipped action satisfies its dependents, so it counts toward done.
  return [c.doneCount(graph.counts.completed + graph.counts.skipped, graph.counts.total),
    graph.counts.failed ? c.failedCount(graph.counts.failed) : null,
    graph.counts.cancelled ? c.cancelledCount(graph.counts.cancelled) : null].filter(Boolean).join(" · ");
}
export function graphAssignee(node: TaskGraphNode): string {
  return node.handled_directly ? appCopy.taskGraph.handledDirectly : node.assignee_ordinal === null ? appCopy.taskGraph.unassigned : appCopy.taskGraph.assignee(node.assignee_ordinal);
}
export function graphElapsed(node: TaskGraphNode, now: number): string | undefined {
  if (!node.started_at) return undefined;
  const start = Date.parse(node.started_at);
  const end = node.finished_at ? Date.parse(node.finished_at) : node.status === "running" ? now : start;
  return Number.isFinite(start) && Number.isFinite(end) ? appCopy.taskGraph.elapsed((end - start) / 1000) : undefined;
}

export function graphStatusLabel(node: TaskGraphNode): string {
  return appCopy.taskGraph.status[node.status];
}

export function graphPhase(graph: TaskGraphSnapshot): string {
  const stage = { conception: "orienting", planning: "planning", execution: "executing", review: "verifying", validation: "verifying", reporting: "reporting" } as const;
  return appCopy.guided.workerStatus[stage[graph.phase]];
}

export function graphMeta(graph: TaskGraphSnapshot): string {
  // A closed Work keeps its last stage; the section status already says it ended.
  const closed = graph.work_state === "completed" || graph.work_state === "abandoned";
  return closed ? graphCounts(graph) : `${graphCounts(graph)} · ${graphPhase(graph)}`;
}
