import { create } from "zustand";
import { getPlanTaskGraph, getSessionTaskGraphs, type TaskGraphSnapshot, type TaskGraphSummary } from "./taskGraphApi.ts";
import type { TimelineEvent } from "./types.ts";

export interface TaskGraphViewState {
  summaries: TaskGraphSummary[];
  graphs: TaskGraphSnapshot[];
  selected: string | null;
  selectionExplicit: boolean;
  open: Record<string, boolean>;
  loading: boolean;
  error: boolean;
}
interface TaskGraphsState {
  taskGraphs: Record<string, TaskGraphViewState>;
  update: (sessionId: string, patch: Partial<TaskGraphViewState>) => void;
}
export const EMPTY_TASK_GRAPHS: TaskGraphViewState = { summaries: [], graphs: [], selected: null, selectionExplicit: false, open: {}, loading: false, error: false };
export const useTaskGraphs = create<TaskGraphsState>((set) => ({
  taskGraphs: {},
  update: (sessionId, patch) => set(state => ({ taskGraphs: { ...state.taskGraphs,
    [sessionId]: { ...EMPTY_TASK_GRAPHS, ...state.taskGraphs[sessionId], ...patch } } })),
}));
const viewers = new Map<string, { count: number; runtimeId: string }>();
const loads = new Map<string, Promise<void>>();
const revisions = new Map<string, number>();
const order = { running: 0, failed: 1, waiting: 2, done: 3, cancelled: 4 };
const view = (id: string) => useTaskGraphs.getState().taskGraphs[id] ?? EMPTY_TASK_GRAPHS;
const update = (id: string, patch: Partial<TaskGraphViewState>) => useTaskGraphs.getState().update(id, patch);

function acceptGraph(sessionId: string, graph: TaskGraphSnapshot) {
  const current = view(sessionId);
  const graphs = [...current.graphs.filter(g => g.graph_id !== graph.graph_id), graph];
  // Keep the original position within each state, including after a revision change.
  const summaries = current.summaries.some(g => g.graph_id === graph.graph_id)
    ? current.summaries.map(g => g.graph_id === graph.graph_id ? graph : g) : [...current.summaries, graph];
  const position = new Map(summaries.map((g, i) => [g.graph_id, i]));
  graphs.sort((a, b) => order[a.state] - order[b.state] || (position.get(a.graph_id) ?? graphs.length) - (position.get(b.graph_id) ?? graphs.length));
  const open = { ...current.open };
  if (!(graph.graph_id in open)) open[graph.graph_id] = graph.state === "running" || graph.state === "failed";
  update(sessionId, { summaries, graphs, open });
}

async function readGraph(graphId: string): Promise<TaskGraphSnapshot> {
  const first = await getPlanTaskGraph(graphId);
  const nodes = [...first.nodes];
  let cursor = first.cursor;
  while (cursor) {
    const page = await getPlanTaskGraph(graphId, { revision: first.graph_revision, cursor });
    nodes.push(...page.nodes);
    cursor = page.cursor;
  }
  if (nodes.length !== first.totals.nodes || first.edges.length !== first.totals.edges) throw new Error("Incomplete task graph");
  return { ...first, nodes, cursor: null };
}

async function refreshGraph(sessionId: string, graphId: string) {
  const key = `${sessionId}/${graphId}`;
  const generation = (revisions.get(key) ?? 0) + 1;
  revisions.set(key, generation);
  try {
    const graph = await readGraph(graphId);
    if (revisions.get(key) === generation) acceptGraph(sessionId, graph);
  } catch { if (revisions.get(key) === generation) update(sessionId, { error: true }); }
}

export function loadTaskGraphs(sessionId: string): Promise<void> {
  const pending = loads.get(sessionId);
  if (pending) return pending;
  update(sessionId, { loading: true, error: false });
  const load = loadSessionGraphs(sessionId).finally(() => {
    update(sessionId, { loading: false });
    loads.delete(sessionId);
  });
  loads.set(sessionId, load);
  return load;
}

async function loadSessionGraphs(sessionId: string) {
  try {
    const initial = view(sessionId);
    const known = new Set(initial.graphs.map(g => g.graph_id));
    const initialized = Object.keys(initial.open).length > 0;
    const first = await getSessionTaskGraphs(sessionId);
    const summaries = [...first.graphs];
    let cursor = first.cursor;
    while (cursor) {
      const page = await getSessionTaskGraphs(sessionId, { revision: first.graph_revision, cursor });
      summaries.push(...page.graphs);
      cursor = page.cursor;
    }
    if (summaries.length !== first.total) throw new Error("Incomplete task graph list");
    update(sessionId, { summaries });
    await Promise.all(summaries.map(summary => {
      const cached = view(sessionId).graphs.find(g => g.graph_id === summary.graph_id);
      return cached?.graph_revision === summary.graph_revision ? undefined : refreshGraph(sessionId, summary.graph_id);
    }));
    const current = view(sessionId);
    const graphs = current.graphs.filter(g => !known.has(g.graph_id) || summaries.some(s => s.graph_id === g.graph_id));
    const selectedExists = graphs.some(g => g.nodes.some(n => n.task_id === current.selected));
    const keepSelection = current.selectionExplicit && selectedExists;
    const selected = keepSelection ? current.selected : defaultTask(graphs);
    const open = { ...current.open };
    if (!initialized && !Object.values(open).some(Boolean) && graphs[0]?.state === "waiting") open[graphs[0].graph_id] = true;
    update(sessionId, { graphs, selected, selectionExplicit: keepSelection, open });
  } catch { update(sessionId, { error: true }); }
}

export function observeTaskGraphs(sessionId: string, runtimeId: string): () => void {
  viewers.set(sessionId, { count: (viewers.get(sessionId)?.count ?? 0) + 1, runtimeId });
  void loadTaskGraphs(sessionId);
  return () => {
    const count = (viewers.get(sessionId)?.count ?? 1) - 1;
    if (count) viewers.set(sessionId, { count, runtimeId }); else viewers.delete(sessionId);
  };
}

export function receiveTaskGraphEvent(event: TimelineEvent): void {
  if (event.type === "stream.reconcile_required") { refreshVisibleTaskGraphs(); return; }
  if (event.type !== "work_model.changed") return;
  const payload = event.payload as Record<string, unknown> | undefined;
  const sessionId = [...viewers].find(([id, viewer]) => id === payload?.session_id || viewer.runtimeId === payload?.session_id)?.[0];
  const planId = payload?.plan_id;
  if (typeof sessionId !== "string" || typeof planId !== "string" || !viewers.has(sessionId)) return;
  const current = view(sessionId).graphs.find(g => g.graph_id === planId);
  if (current?.graph_revision === payload?.graph_revision) return;
  void refreshGraph(sessionId, planId).then(() => {
    const state = view(sessionId);
    const selectedExists = state.graphs.some(g => g.nodes.some(n => n.task_id === state.selected));
    if (!state.selectionExplicit || !selectedExists) update(sessionId, { selected: defaultTask(state.graphs), selectionExplicit: false });
  });
}

export function refreshVisibleTaskGraphs(): void {
  for (const sessionId of viewers.keys()) void loadTaskGraphs(sessionId);
}

function defaultTask(graphs: TaskGraphSnapshot[]): string | null {
  const nodes = graphs.flatMap(g => g.nodes);
  for (const status of ["running", "failed", "blocked"]) {
    const node = nodes.find(n => n.status === status);
    if (node) return node.task_id;
  }
  const finished = nodes.filter(n => n.status === "completed" || n.status === "cancelled")
    .sort((a, b) => Date.parse(a.finished_at ?? "1970-01-01") - Date.parse(b.finished_at ?? "1970-01-01"));
  return finished.at(-1)?.task_id ?? nodes[0]?.task_id ?? null;
}
