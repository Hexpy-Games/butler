import type { TaskGraphChanged, TaskGraphSnapshot } from "./taskGraphApi.ts";

/** A complete revision-bound delta; a gap is recovered through the read API. */
export function patchTaskGraph(current: TaskGraphSnapshot, change: TaskGraphChanged): TaskGraphSnapshot | null {
  if (change.removed || change.refetch || change.previous_graph_revision !== current.graph_revision) return null;
  const nodes = new Map(current.nodes.map(node => [node.task_id, node]));
  for (const entity of change.entity_changes) {
    if (entity.type === "remove") nodes.delete(entity.task_id);
    else nodes.set(entity.task_id, entity.node);
  }
  if (!change.node_order || change.node_order.length !== nodes.size || change.node_order.some(id => !nodes.has(id))) return null;
  const ordered = change.node_order.map(id => nodes.get(id)!);
  return { ...current, graph_revision: change.graph_revision, title: change.title, state: change.state,
    phase: change.phase, work_state: change.work_state, counts: change.counts, updated_at: change.updated_at,
    nodes: ordered, edges: change.edges, totals: { nodes: ordered.length, edges: change.edges.length },
    cursor: null, event_seq: change.event_seq };
}
