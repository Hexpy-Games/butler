import type { TaskGraphCopy, TaskStatus } from "./copy";
import type { TaskGraph } from "./fixture";

// Per-graph rollups for the multi-graph Tasks tab. Pure; derived from node states only.

export type GraphState = "running" | "failed" | "pending" | "completed" | "cancelled";

export function graphState(graph: TaskGraph): GraphState {
  const has = (status: TaskStatus) => graph.nodes.some((node) => node.status === status);
  if (has("running") || has("awaiting_review")) return "running";
  if (has("failed") || has("blocked")) return "failed";
  const open = graph.nodes.filter((node) => node.status !== "completed");
  if (open.length === 0) return "completed";
  if (open.every((node) => node.status === "cancelled")) return "cancelled";
  if (has("cancelled") && !graph.nodes.some((node) => node.status === "pending" || node.status === "paused")) return "cancelled";
  return "pending";
}

/** Tag/glyph state for a graph row, mapped onto the task status vocabulary. */
export const GRAPH_STATUS: Record<GraphState, TaskStatus> = {
  running: "running", failed: "failed", pending: "pending", completed: "completed", cancelled: "cancelled",
};

const ORDER: GraphState[] = ["running", "failed", "pending", "completed", "cancelled"];

/** Running first, then failed, waiting, done, cancelled; stable within a state. */
export function orderGraphs(graphs: TaskGraph[]): TaskGraph[] {
  return graphs.map((graph, i) => ({ graph, i, rank: ORDER.indexOf(graphState(graph)) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i).map((item) => item.graph);
}

/** "3/6 완료 · 실패 1 · 취소 2" — exact totals, cancelled tasks stay counted. */
export function graphCounts(graph: TaskGraph, copy: TaskGraphCopy): string {
  const count = (status: TaskStatus) => graph.nodes.filter((node) => node.status === status).length;
  const failed = count("failed");
  const cancelled = count("cancelled");
  return [copy.doneCount(count("completed"), graph.nodes.length), failed ? copy.failedCount(failed) : null, cancelled ? copy.cancelledCount(cancelled) : null]
    .filter(Boolean).join(" · ");
}

/** Open by default: running and failed graphs; with none, the first graph. */
export function defaultOpen(ordered: TaskGraph[]): Set<string> {
  const open = ordered.filter((graph) => ["running", "failed"].includes(graphState(graph))).map((graph) => graph.id);
  return new Set(open.length ? open : ordered.slice(0, 1).map((graph) => graph.id));
}
