//! `app/taskGraphState.ts`: the task graphs of the open session.
//!
//! The pure state of the zustand store: the graphs per session, the load and refresh
//! generations, and what a live `work_model.changed` event asks for. The routes run in
//! `inspector/tasks`, which feeds their results in here.
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use chrono::DateTime;
use serde::Deserialize as _;
use serde_json::Value;

use crate::ui::source::wire::{
    TaskGraphChangedWire, TaskGraphEntityChangeWire, TaskGraphNodeWire, TaskGraphSnapshotWire,
    TaskGraphStateWire, TaskGraphStatusWire, TaskGraphSummaryWire,
};

/// `TaskGraphViewState`
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct TaskGraphViewState {
    pub(crate) summaries: Vec<TaskGraphSummaryWire>,
    pub(crate) graphs: Vec<TaskGraphSnapshotWire>,
    pub(crate) selected: Option<String>,
    pub(crate) selection_explicit: bool,
    pub(crate) open: HashMap<String, bool>,
    pub(crate) loading: bool,
    pub(crate) error: bool,
}

/// What a load began from: the graphs it already knew and whether `open` was set before.
pub(crate) struct LoadStart {
    known: HashSet<String>,
    initialized: bool,
}

/// What a live event asks the host to run.
pub(crate) enum TaskGraphAction {
    /// `loadTaskGraphs(session)`
    Load(String),
    /// `refreshGraph(session, plan)`, then `reconcileSelection`.
    Refresh { session: String, plan: String },
}

#[derive(Default)]
pub(crate) struct TaskGraphs {
    /// Shared so a frame reads a state without copying its graphs.
    views: HashMap<String, Rc<TaskGraphViewState>>,
    /// `viewers`: the sessions whose panel is shown, with their runtime id.
    viewers: HashMap<String, String>,
    /// `loads`: sessions with a load in flight.
    loads: HashSet<String>,
    /// Loads to run again once the one in flight ended.
    reload: HashSet<String>,
    /// `revisions`: the generation of each `session/graph` read.
    revisions: HashMap<String, u64>,
}

fn state_rank(state: TaskGraphStateWire) -> u8 {
    match state {
        TaskGraphStateWire::Running => 0,
        TaskGraphStateWire::Failed => 1,
        TaskGraphStateWire::Waiting => 2,
        TaskGraphStateWire::Done => 3,
        TaskGraphStateWire::Cancelled => 4,
        TaskGraphStateWire::Unknown => 5,
    }
}

fn key(session: &str, graph: &str) -> String {
    format!("{session}/{graph}")
}

fn millis(at: Option<&str>) -> i64 {
    at.and_then(|at| DateTime::parse_from_rfc3339(at).ok())
        .map_or(0, |at| at.timestamp_millis())
}

/// `defaultTask`
fn default_task(graphs: &[TaskGraphSnapshotWire]) -> Option<String> {
    let nodes = || graphs.iter().flat_map(|graph| graph.nodes.iter());
    for status in [
        TaskGraphStatusWire::Running,
        TaskGraphStatusWire::Failed,
        TaskGraphStatusWire::Blocked,
    ] {
        if let Some(node) = nodes().find(|node| node.status == status) {
            return Some(node.task_id.clone());
        }
    }
    nodes()
        .filter(|node| {
            matches!(
                node.status,
                TaskGraphStatusWire::Done
                    | TaskGraphStatusWire::Skipped
                    | TaskGraphStatusWire::Cancelled
            )
        })
        .max_by_key(|node| millis(node.finished_at.as_deref()))
        .or_else(|| nodes().next())
        .map(|node| node.task_id.clone())
}

/// `patchTaskGraph`: a complete revision-bound delta; a gap is recovered through the read API.
fn patch_task_graph(
    current: &TaskGraphSnapshotWire,
    change: &TaskGraphChangedWire,
) -> Option<TaskGraphSnapshotWire> {
    if change.removed
        || change.refetch
        || change.previous_graph_revision.as_deref()
            != Some(current.summary.graph_revision.as_str())
    {
        return None;
    }
    let mut nodes: HashMap<String, TaskGraphNodeWire> = current
        .nodes
        .iter()
        .map(|node| (node.task_id.clone(), node.clone()))
        .collect();
    for entity in &change.entity_changes {
        match entity {
            TaskGraphEntityChangeWire::Remove { task_id } => {
                nodes.remove(task_id);
            }
            TaskGraphEntityChangeWire::Upsert { task_id, node } => {
                nodes.insert(task_id.clone(), (**node).clone());
            }
        }
    }
    let order = change.node_order.as_ref()?;
    if order.len() != nodes.len() || order.iter().any(|id| !nodes.contains_key(id)) {
        return None;
    }
    let ordered: Vec<TaskGraphNodeWire> = order
        .iter()
        .map(|id| nodes.remove(id))
        .collect::<Option<_>>()?;
    let mut patched = current.clone();
    patched.summary = TaskGraphSummaryWire {
        graph_id: current.summary.graph_id.clone(),
        phase: change.phase?,
        work_state: change.work_state?,
        title: change.title.clone()?,
        state: change.state?,
        counts: change.counts.clone()?,
        graph_revision: change.graph_revision.clone(),
        updated_at: change.updated_at.clone()?,
    };
    patched.totals.nodes = u64::try_from(ordered.len()).ok()?;
    patched.totals.edges = u64::try_from(change.edges.len()).ok()?;
    patched.nodes = ordered;
    patched.edges.clone_from(&change.edges);
    patched.cursor = None;
    patched.event_seq = change.event_seq;
    Some(patched)
}

impl TaskGraphs {
    pub(crate) fn view(&self, session: &str) -> Option<Rc<TaskGraphViewState>> {
        self.views.get(session).cloned()
    }

    fn view_mut(&mut self, session: &str) -> &mut TaskGraphViewState {
        Rc::make_mut(self.views.entry(session.to_owned()).or_default())
    }

    /// `update(sessionId, { selected, selectionExplicit: true })`
    pub(crate) fn select(&mut self, session: &str, task: &str) {
        let view = self.view_mut(session);
        view.selected = Some(task.to_owned());
        view.selection_explicit = true;
    }

    /// `update(sessionId, { open: { ...open, [graphId]: !open[graphId] } })`
    pub(crate) fn toggle(&mut self, session: &str, graph: &str) {
        let open = &mut self.view_mut(session).open;
        let now = open.get(graph).copied().unwrap_or(false);
        open.insert(graph.to_owned(), !now);
    }

    /// `observeTaskGraphs`: the shown panel is the only viewer. True when `session` was not
    /// observed yet, so its graphs should load.
    pub(crate) fn observe(&mut self, session: &str, runtime: &str) -> bool {
        self.viewers.retain(|id, _| id == session);
        // Sessions no longer observed keep nothing.
        self.views.retain(|id, _| id == session);
        let prefix = format!("{session}/");
        self.revisions.retain(|id, _| id.starts_with(&prefix));
        self.viewers
            .insert(session.to_owned(), runtime.to_owned())
            .is_none()
    }

    fn bump(&mut self, key: String) -> u64 {
        let generation = self.revisions.entry(key).or_insert(0);
        *generation += 1;
        *generation
    }

    /// `loadTaskGraphs`: none when a load is already in flight.
    pub(crate) fn begin_load(&mut self, session: &str) -> Option<LoadStart> {
        if !self.loads.insert(session.to_owned()) {
            return None;
        }
        let view = self.view_mut(session);
        view.loading = true;
        view.error = false;
        Some(LoadStart {
            known: view
                .graphs
                .iter()
                .map(|graph| graph.summary.graph_id.clone())
                .collect(),
            initialized: !view.open.is_empty(),
        })
    }

    /// The `finally` of a load; true when an event asked for another load meanwhile.
    pub(crate) fn end_load(&mut self, session: &str) -> bool {
        self.view_mut(session).loading = false;
        self.loads.remove(session);
        self.reload.remove(session)
    }

    pub(crate) fn load_failed(&mut self, session: &str) {
        self.view_mut(session).error = true;
    }

    /// The summaries of a load arrived: graphs that left are dropped, and the ids of the graphs
    /// whose cached revision differs are returned to be read.
    pub(crate) fn apply_summaries(
        &mut self,
        session: &str,
        start: &LoadStart,
        summaries: Vec<TaskGraphSummaryWire>,
    ) -> Vec<String> {
        let present: HashSet<String> = summaries.iter().map(|g| g.graph_id.clone()).collect();
        for id in start.known.iter().filter(|id| !present.contains(*id)) {
            self.bump(key(session, id));
        }
        let view = self.view_mut(session);
        view.graphs.retain(|g| {
            !start.known.contains(&g.summary.graph_id) || present.contains(&g.summary.graph_id)
        });
        let stale = summaries
            .iter()
            .filter(|summary| {
                !view.graphs.iter().any(|g| {
                    g.summary.graph_id == summary.graph_id
                        && g.summary.graph_revision == summary.graph_revision
                })
            })
            .map(|summary| summary.graph_id.clone())
            .collect();
        view.summaries = summaries;
        stale
    }

    /// The tail of `loadSessionGraphs`: drop graphs that left, then pick the selection and the
    /// graph to open.
    pub(crate) fn finish_load(&mut self, session: &str, start: &LoadStart) {
        let view = self.view_mut(session);
        let summaries = &view.summaries;
        view.graphs.retain(|g| {
            !start.known.contains(&g.summary.graph_id)
                || summaries.iter().any(|s| s.graph_id == g.summary.graph_id)
        });
        let keep = view.selection_explicit && selected_exists(view);
        if !keep {
            view.selected = default_task(&view.graphs);
        }
        view.selection_explicit = keep;
        if !start.initialized
            && !view.open.values().any(|open| *open)
            && let Some(first) = view
                .graphs
                .first()
                .filter(|g| g.summary.state == TaskGraphStateWire::Waiting)
        {
            view.open.insert(first.summary.graph_id.clone(), true);
        }
    }

    /// `refreshGraph` begins: the generation its result must still match.
    pub(crate) fn begin_refresh(&mut self, session: &str, graph: &str) -> u64 {
        self.bump(key(session, graph))
    }

    /// `refreshGraph` ends: a result of a superseded generation is dropped.
    pub(crate) fn finish_refresh(
        &mut self,
        session: &str,
        graph: &str,
        generation: u64,
        read: Option<TaskGraphSnapshotWire>,
    ) {
        if self.revisions.get(&key(session, graph)) != Some(&generation) {
            return;
        }
        match read {
            Some(read) => self.accept_graph(session, read),
            None => self.view_mut(session).error = true,
        }
    }

    /// `acceptGraph`: keeps the original position within each state, including after a
    /// revision change.
    fn accept_graph(&mut self, session: &str, graph: TaskGraphSnapshotWire) {
        let view = self.view_mut(session);
        let id = graph.summary.graph_id.clone();
        view.graphs.retain(|g| g.summary.graph_id != id);
        match view.summaries.iter_mut().find(|g| g.graph_id == id) {
            Some(slot) => *slot = graph.summary.clone(),
            None => view.summaries.push(graph.summary.clone()),
        }
        let live = matches!(
            graph.summary.state,
            TaskGraphStateWire::Running | TaskGraphStateWire::Failed
        );
        view.graphs.push(graph);
        let position: HashMap<&str, usize> = view
            .summaries
            .iter()
            .enumerate()
            .map(|(index, g)| (g.graph_id.as_str(), index))
            .collect();
        let end = view.graphs.len();
        view.graphs.sort_by_key(|g| {
            let place = position.get(g.summary.graph_id.as_str()).copied();
            (state_rank(g.summary.state), place.unwrap_or(end))
        });
        view.open.entry(id).or_insert(live);
    }

    /// `reconcileSelection`
    pub(crate) fn reconcile_selection(&mut self, session: &str) {
        let view = self.view_mut(session);
        if !view.selection_explicit || !selected_exists(view) {
            view.selected = default_task(&view.graphs);
            view.selection_explicit = false;
        }
    }

    fn remove_graph(&mut self, session: &str, plan: &str) {
        self.bump(key(session, plan));
        let view = self.view_mut(session);
        view.graphs.retain(|g| g.summary.graph_id != plan);
        view.summaries.retain(|g| g.graph_id != plan);
        self.reconcile_selection(session);
    }

    /// A newly planned Work can replace its parent even with a cold event cache: load again,
    /// after the load in flight.
    fn load_after_pending(&mut self, session: &str) -> Vec<TaskGraphAction> {
        if self.loads.contains(session) {
            self.reload.insert(session.to_owned());
            Vec::new()
        } else {
            vec![TaskGraphAction::Load(session.to_owned())]
        }
    }

    /// `receiveTaskGraphEvent`
    pub(crate) fn receive_event(&mut self, kind: &str, payload: &Value) -> Vec<TaskGraphAction> {
        if kind == "stream.reconcile_required" {
            return self
                .viewers
                .keys()
                .cloned()
                .map(TaskGraphAction::Load)
                .collect();
        }
        if kind != "work_model.changed" {
            return Vec::new();
        }
        let Ok(change) = TaskGraphChangedWire::deserialize(payload) else {
            return Vec::new();
        };
        let Some(session) = self
            .viewers
            .iter()
            .find(|(id, runtime)| **id == change.session_id || **runtime == change.session_id)
            .map(|(id, _)| id.clone())
        else {
            return Vec::new();
        };
        if change.removed {
            self.remove_graph(&session, &change.plan_id);
            return Vec::new();
        }
        let Some(current) = self.views.get(&session).and_then(|view| {
            view.graphs
                .iter()
                .find(|g| g.summary.graph_id == change.plan_id)
        }) else {
            return self.load_after_pending(&session);
        };
        if current.summary.graph_revision == change.graph_revision {
            return Vec::new();
        }
        let Some(patched) = patch_task_graph(current, &change) else {
            return vec![TaskGraphAction::Refresh {
                session,
                plan: change.plan_id,
            }];
        };
        self.bump(key(&session, &change.plan_id));
        self.accept_graph(&session, patched);
        self.reconcile_selection(&session);
        Vec::new()
    }
}

fn selected_exists(view: &TaskGraphViewState) -> bool {
    view.graphs.iter().any(|g| {
        g.nodes
            .iter()
            .any(|n| view.selected.as_deref() == Some(n.task_id.as_str()))
    })
}
