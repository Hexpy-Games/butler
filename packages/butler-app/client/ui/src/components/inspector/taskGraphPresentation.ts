import { appCopy } from "@/app/copy.ts";
import type { TaskGraphNode, TaskGraphSnapshot } from "@/app/taskGraphApi.ts";
import type { TaskGraphStatus } from "@/butler-ds";

export function graphTaskStatus(node: TaskGraphNode): TaskGraphStatus {
  if (node.status === "completed") return "done";
  if (node.status === "in_review") return "review";
  return node.status;
}
export function graphCounts(graph: TaskGraphSnapshot): string {
  const c = appCopy.taskGraph;
  return [c.doneCount(graph.counts.completed, graph.counts.total),
    graph.counts.failed ? c.failedCount(graph.counts.failed) : null,
    graph.counts.cancelled ? c.cancelledCount(graph.counts.cancelled) : null].filter(Boolean).join(" · ");
}
export function graphAssignee(node: TaskGraphNode): string {
  return node.assignee_ordinal === null ? appCopy.taskGraph.unassigned : appCopy.taskGraph.assignee(node.assignee_ordinal);
}
export function graphElapsed(node: TaskGraphNode, now: number): string | undefined {
  if (!node.started_at) return undefined;
  const start = Date.parse(node.started_at);
  const end = node.finished_at ? Date.parse(node.finished_at) : node.status === "running" ? now : start;
  return Number.isFinite(start) && Number.isFinite(end) ? appCopy.taskGraph.elapsed((end - start) / 1000) : undefined;
}
