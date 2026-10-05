import type { TaskEdge, TaskGraph, TaskNode } from "./fixture";

// Pure layout of a task DAG. Rendering only: it never changes order, status or edges.
// Codex keeps this as-is (one file, no dependency); O(V + E) apart from one barycenter sort per rank.

export interface GraphIndex {
  byId: Map<string, TaskNode>;
  preds: Map<string, string[]>;
  succs: Map<string, string[]>;
}

export function indexGraph(graph: TaskGraph): GraphIndex {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const preds = new Map<string, string[]>(graph.nodes.map((node) => [node.id, []]));
  const succs = new Map<string, string[]>(graph.nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    preds.get(edge.to)!.push(edge.from);
    succs.get(edge.from)!.push(edge.to);
  }
  return { byId, preds, succs };
}

/** Columns of node ids: rank = longest path from a source; order by predecessor barycenter. */
export function layeredColumns(graph: TaskGraph, index: GraphIndex): string[][] {
  const rank = new Map<string, number>();
  const visit = (id: string): number => {
    const known = rank.get(id);
    if (known !== undefined) return known;
    rank.set(id, 0); // cycle guard: the runtime rejects cycles, the view must not hang on one
    const value = Math.max(-1, ...index.preds.get(id)!.map(visit)) + 1;
    rank.set(id, value);
    return value;
  };
  graph.nodes.forEach((node) => visit(node.id));
  const columns: string[][] = [];
  for (const node of graph.nodes) (columns[rank.get(node.id)!] ??= []).push(node.id);
  for (let r = 1; r < columns.length; r += 1) {
    const position = new Map(columns[r - 1]!.map((id, i) => [id, i]));
    const center = (id: string) => {
      const values = index.preds.get(id)!.map((p) => position.get(p)).filter((v): v is number => v !== undefined);
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    };
    columns[r] = [...columns[r]!].sort((a, b) => center(a) - center(b));
  }
  return columns.filter(Boolean);
}

export interface LaneLayout {
  rows: string[];
  lane: Map<string, number>;
  edgeLane: Map<string, number>;
  laneCount: number;
}

export const edgeKey = (edge: TaskEdge) => `${edge.from}->${edge.to}`;

/** Top-to-bottom rows with git-log style lanes: a lane stays reserved while its edge is open. */
export function laneLayout(columns: string[][], index: GraphIndex): LaneLayout {
  const rows = columns.flat();
  const order = new Map(rows.map((id, i) => [id, i]));
  const open: (TaskEdge | null)[] = [];
  const lane = new Map<string, number>();
  const edgeLane = new Map<string, number>();
  const free = (skip = -1) => {
    const at = open.findIndex((slot, i) => slot === null && i !== skip);
    return at >= 0 ? at : open.push(null) - 1;
  };
  for (const id of rows) {
    const incoming = open.flatMap((slot, i) => (slot?.to === id ? [i] : []));
    const mine = incoming.length ? Math.min(...incoming) : free();
    incoming.forEach((i) => { open[i] = null; });
    lane.set(id, mine);
    const targets = [...index.succs.get(id)!].sort((a, b) => order.get(a)! - order.get(b)!);
    targets.forEach((to, j) => {
      const at = j === 0 && open[mine] === null ? mine : free(mine);
      open[at] = { from: id, to };
      edgeLane.set(edgeKey({ from: id, to }), at);
    });
  }
  return { rows, lane, edgeLane, laneCount: Math.max(1, open.length) };
}

/** Default selection: the first running task, else the first failed, else the last finished. */
export function defaultSelection(graph: TaskGraph): string | null {
  const find = (status: TaskNode["status"]) => graph.nodes.find((node) => node.status === status)?.id;
  return find("running") ?? find("failed") ?? find("blocked")
    ?? [...graph.nodes].reverse().find((node) => node.status !== "pending")?.id ?? graph.nodes[0]?.id ?? null;
}
