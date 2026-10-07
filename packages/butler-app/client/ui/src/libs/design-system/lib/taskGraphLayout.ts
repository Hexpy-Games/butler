/**
 * Pure layout for read-only task DAGs (TaskGraphCanvas, TaskGraphLanes).
 * Rendering only: it never reorders, edits or validates the graph.
 *
 * Cost: ranks are O(V + E) (memoised DFS); rank-skipping edges add one dummy
 * slot per skipped rank (D in total); ordering is one barycentre pass, a sort
 * per column, O((V + D) log(V + D)); lanes are O(V + E). Recompute only when
 * the graph revision changes, never on scroll or resize.
 */

export interface TaskGraphEdge {
  from: string;
  to: string;
}

export interface TaskGraphIndex {
  ids: string[];
  preds: Map<string, string[]>;
  succs: Map<string, string[]>;
}

/** A column entry: a task, or a dummy that carries a rank-skipping edge through this column. */
export type TaskGraphSlot =
  | { kind: "node"; id: string }
  | { kind: "dummy"; id: string; edge: string };

export interface TaskGraphColumns {
  columns: TaskGraphSlot[][];
  rank: Map<string, number>;
  /** Slot ids each edge passes through, from source to target (dummies in between). */
  routes: Map<string, string[]>;
}

export const taskGraphEdgeKey = (edge: TaskGraphEdge) => `${edge.from}->${edge.to}`;

/** Adjacency for the given ids. Unknown endpoints and self-edges are ignored. */
export function indexTaskGraph(ids: readonly string[], edges: readonly TaskGraphEdge[]): TaskGraphIndex {
  const known = new Set(ids);
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  const succs = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of edges) {
    if (edge.from === edge.to || !known.has(edge.from) || !known.has(edge.to)) continue;
    preds.get(edge.to)!.push(edge.from);
    succs.get(edge.from)!.push(edge.to);
  }
  return { ids: [...ids], preds, succs };
}

/** Longest path from a source. A cycle (the runtime rejects them) cannot hang the view. */
export function taskGraphRanks(index: TaskGraphIndex): Map<string, number> {
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = rank.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let value = 0;
    for (const pred of index.preds.get(id)!) value = Math.max(value, visit(pred) + 1);
    visiting.delete(id);
    rank.set(id, value);
    return value;
  };
  for (const id of index.ids) visit(id);
  return rank;
}

/** Ranked columns with dummy slots for rank-skipping edges, ordered by predecessor barycentre. */
export function layoutTaskGraph(index: TaskGraphIndex): TaskGraphColumns {
  const rank = taskGraphRanks(index);
  const columns: TaskGraphSlot[][] = [];
  const slotPreds = new Map<string, string[]>();
  const routes = new Map<string, string[]>();
  for (const id of index.ids) {
    (columns[rank.get(id)!] ??= []).push({ kind: "node", id });
    slotPreds.set(id, []);
  }
  for (const id of index.ids) {
    for (const to of index.succs.get(id)!) {
      const edge = taskGraphEdgeKey({ from: id, to });
      const route = [id];
      for (let r = rank.get(id)! + 1; r < rank.get(to)!; r += 1) {
        const dummy = `${edge}#${r}`;
        (columns[r] ??= []).push({ kind: "dummy", id: dummy, edge });
        slotPreds.set(dummy, [route.at(-1)!]);
        route.push(dummy);
      }
      slotPreds.get(to)!.push(route.at(-1)!);
      route.push(to);
      routes.set(edge, route);
    }
  }
  const dense = columns.filter(Boolean);
  for (let r = 1; r < dense.length; r += 1) {
    const position = new Map(dense[r - 1]!.map((slot, i) => [slot.id, i]));
    const centre = new Map(dense[r]!.map((slot, i) => {
      const at = slotPreds.get(slot.id)!.map((pred) => position.get(pred)).filter((v): v is number => v !== undefined);
      return [slot.id, at.length ? at.reduce((a, b) => a + b, 0) / at.length : i] as const;
    }));
    dense[r] = [...dense[r]!].sort((a, b) => centre.get(a.id)! - centre.get(b.id)!);
  }
  return { columns: dense, rank, routes };
}

export interface TaskGraphLanes {
  /** Tasks top to bottom (rank, then column order). */
  rows: string[];
  lane: Map<string, number>;
  /** Lane each edge travels in between its rows. */
  edgeLane: Map<string, number>;
  laneCount: number;
}

/** Vertical lanes, git-log style: a lane stays reserved while its edge is open. */
export function laneTaskGraph(layout: TaskGraphColumns, index: TaskGraphIndex): TaskGraphLanes {
  const rows = layout.columns.flatMap((column) => column.flatMap((slot) => (slot.kind === "node" ? [slot.id] : [])));
  const order = new Map(rows.map((id, i) => [id, i]));
  const open: (TaskGraphEdge | null)[] = [];
  const lane = new Map<string, number>();
  const edgeLane = new Map<string, number>();
  const free = (skip = -1) => {
    const at = open.findIndex((slot, i) => slot === null && i !== skip);
    return at >= 0 ? at : open.push(null) - 1;
  };
  for (const id of rows) {
    const incoming = open.flatMap((slot, i) => (slot?.to === id ? [i] : []));
    const mine = incoming.length ? Math.min(...incoming) : free();
    for (const i of incoming) open[i] = null;
    lane.set(id, mine);
    const targets = [...index.succs.get(id)!].sort((a, b) => order.get(a)! - order.get(b)!);
    targets.forEach((to, j) => {
      const at = j === 0 && open[mine] === null ? mine : free(mine);
      open[at] = { from: id, to };
      edgeLane.set(taskGraphEdgeKey({ from: id, to }), at);
    });
  }
  return { rows, lane, edgeLane, laneCount: Math.max(1, open.length) };
}

export type TaskGraphStatus = "pending" | "running" | "review" | "done" | "failed" | "blocked" | "cancelled" | "paused";
export type TaskGraphEdgeState = "satisfied" | "waiting" | "failed" | "active";

/** Solid once the prerequisite is done; failed/cancelled sources break; a satisfied edge into running is active. */
export function taskGraphEdgeState(from: TaskGraphStatus, to: TaskGraphStatus): TaskGraphEdgeState {
  if (from === "failed" || from === "cancelled") return "failed";
  if (from !== "done") return "waiting";
  return to === "running" ? "active" : "satisfied";
}

/** One state for a whole graph (section rows): running > failed > waiting > done > cancelled. */
export function rollupTaskGraphStatus(statuses: readonly TaskGraphStatus[]): TaskGraphStatus {
  const has = (status: TaskGraphStatus) => statuses.includes(status);
  if (has("running") || has("review")) return "running";
  if (has("failed") || has("blocked")) return "failed";
  if (statuses.every((status) => status === "done")) return "done";
  if (has("pending") || has("paused")) return "pending";
  return "cancelled";
}
