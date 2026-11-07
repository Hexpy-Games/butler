//! Pure layout for read-only task DAGs (`lib/taskGraphLayout.ts`): ranked columns with dummy
//! slots for rank-skipping edges (the canvas), vertical lanes (the phone layout), the edge state
//! and the rolled-up graph status. It never reorders, edits or validates the graph.
//!
//! Ranks are O(V + E) (memoised DFS); ordering is one barycentre pass and a sort per column;
//! lanes are O(V + E). [`cached_shape`] recomputes only when the graph changes.
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use gpui::{App, ElementId, SharedString, Window};

use crate::ui::blocks::task_graph_card::TaskGraphStatus;

/// A prerequisite edge: `from` must finish before `to`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskGraphEdge {
    pub from: SharedString,
    pub to: SharedString,
}

impl TaskGraphEdge {
    pub fn new(from: impl Into<SharedString>, to: impl Into<SharedString>) -> Self {
        Self {
            from: from.into(),
            to: to.into(),
        }
    }

    pub fn key(&self) -> SharedString {
        edge_key(&self.from, &self.to)
    }
}

/// `taskGraphEdgeKey`: `from->to`.
pub fn edge_key(from: &SharedString, to: &SharedString) -> SharedString {
    SharedString::from(format!("{from}->{to}"))
}

type Adjacency = HashMap<SharedString, Vec<SharedString>>;

/// Adjacency for the given ids (`TaskGraphIndex`).
#[derive(Clone, Debug)]
pub struct TaskGraphIndex {
    pub ids: Vec<SharedString>,
    preds: Adjacency,
    succs: Adjacency,
}

impl TaskGraphIndex {
    /// Unknown endpoints and self-edges are ignored.
    pub fn new(ids: &[SharedString], edges: &[TaskGraphEdge]) -> Self {
        let known: HashSet<&SharedString> = ids.iter().collect();
        let mut preds: Adjacency = ids.iter().map(|id| (id.clone(), Vec::new())).collect();
        let mut succs = preds.clone();
        for edge in edges {
            if edge.from == edge.to || !known.contains(&edge.from) || !known.contains(&edge.to) {
                continue;
            }
            if let Some(list) = preds.get_mut(&edge.to) {
                list.push(edge.from.clone());
            }
            if let Some(list) = succs.get_mut(&edge.from) {
                list.push(edge.to.clone());
            }
        }
        Self {
            ids: ids.to_vec(),
            preds,
            succs,
        }
    }

    pub fn preds_of(&self, id: &SharedString) -> &[SharedString] {
        self.preds.get(id).map_or(&[], Vec::as_slice)
    }

    pub fn succs_of(&self, id: &SharedString) -> &[SharedString] {
        self.succs.get(id).map_or(&[], Vec::as_slice)
    }
}

/// A column entry: a task, or a dummy that carries a rank-skipping edge through the column.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TaskGraphSlot {
    Node(SharedString),
    Dummy(SharedString),
}

impl TaskGraphSlot {
    pub fn id(&self) -> &SharedString {
        match self {
            Self::Node(id) | Self::Dummy(id) => id,
        }
    }
}

/// The slots an edge passes through, from its source to its target (dummies in between).
#[derive(Clone, Debug)]
pub struct Route {
    pub from: SharedString,
    pub to: SharedString,
    pub slots: Vec<SharedString>,
}

/// Ranked columns (`TaskGraphColumns`).
#[derive(Clone, Debug)]
pub struct ColumnLayout {
    pub columns: Vec<Vec<TaskGraphSlot>>,
    pub routes: Vec<Route>,
}

/// Longest path from a source. A cycle (the runtime rejects them) cannot hang the view.
fn ranks(index: &TaskGraphIndex) -> HashMap<SharedString, usize> {
    fn visit(
        index: &TaskGraphIndex,
        id: &SharedString,
        rank: &mut HashMap<SharedString, usize>,
        visiting: &mut HashSet<SharedString>,
    ) -> usize {
        if let Some(&known) = rank.get(id) {
            return known;
        }
        if !visiting.insert(id.clone()) {
            return 0;
        }
        let mut value = 0;
        for pred in index.preds_of(id) {
            value = value.max(visit(index, pred, rank, visiting) + 1);
        }
        visiting.remove(id);
        rank.insert(id.clone(), value);
        value
    }
    let mut rank = HashMap::new();
    let mut visiting = HashSet::new();
    for id in &index.ids {
        visit(index, id, &mut rank, &mut visiting);
    }
    rank
}

fn column_mut(columns: &mut Vec<Vec<TaskGraphSlot>>, rank: usize) -> &mut Vec<TaskGraphSlot> {
    if columns.len() <= rank {
        columns.resize_with(rank + 1, Vec::new);
    }
    &mut columns[rank]
}

/// Threads the edge `from -> to` through one dummy slot per skipped rank.
fn thread(
    (from, to): (&SharedString, &SharedString),
    rank: &HashMap<SharedString, usize>,
    columns: &mut Vec<Vec<TaskGraphSlot>>,
    slot_preds: &mut Adjacency,
) -> Route {
    let key = edge_key(from, to);
    let at = |id: &SharedString| rank.get(id).copied().unwrap_or(0);
    let mut slots = vec![from.clone()];
    for r in at(from) + 1..at(to) {
        let dummy = SharedString::from(format!("{key}#{r}"));
        column_mut(columns, r).push(TaskGraphSlot::Dummy(dummy.clone()));
        slot_preds.insert(dummy.clone(), slots.last().cloned().into_iter().collect());
        slots.push(dummy);
    }
    if let (Some(preds), Some(last)) = (slot_preds.get_mut(to), slots.last()) {
        preds.push(last.clone());
    }
    slots.push(to.clone());
    Route {
        from: from.clone(),
        to: to.clone(),
        slots,
    }
}

/// Orders each column by the barycentre of its predecessors in the column before it.
fn order(columns: Vec<Vec<TaskGraphSlot>>, slot_preds: &Adjacency) -> Vec<Vec<TaskGraphSlot>> {
    let mut dense: Vec<Vec<TaskGraphSlot>> =
        columns.into_iter().filter(|c| !c.is_empty()).collect();
    for r in 1..dense.len() {
        let position: HashMap<SharedString, usize> = dense[r - 1]
            .iter()
            .enumerate()
            .map(|(i, slot)| (slot.id().clone(), i))
            .collect();
        let mut keyed: Vec<(f32, TaskGraphSlot)> = std::mem::take(&mut dense[r])
            .into_iter()
            .enumerate()
            .map(|(i, slot)| {
                let at: Vec<usize> = slot_preds
                    .get(slot.id())
                    .into_iter()
                    .flatten()
                    .filter_map(|pred| position.get(pred).copied())
                    .collect();
                let centre = if at.is_empty() {
                    i as f32
                } else {
                    at.iter().sum::<usize>() as f32 / at.len() as f32
                };
                (centre, slot)
            })
            .collect();
        keyed.sort_by(|a, b| a.0.total_cmp(&b.0));
        dense[r] = keyed.into_iter().map(|(_, slot)| slot).collect();
    }
    dense
}

/// `layoutTaskGraph`: ranked columns with dummy slots for rank-skipping edges.
pub fn layout_columns(index: &TaskGraphIndex) -> ColumnLayout {
    let rank = ranks(index);
    let mut columns: Vec<Vec<TaskGraphSlot>> = Vec::new();
    let mut slot_preds: Adjacency = HashMap::new();
    for id in &index.ids {
        let at = rank.get(id).copied().unwrap_or(0);
        column_mut(&mut columns, at).push(TaskGraphSlot::Node(id.clone()));
        slot_preds.insert(id.clone(), Vec::new());
    }
    let mut routes = Vec::new();
    for id in &index.ids {
        for to in index.succs_of(id) {
            routes.push(thread((id, to), &rank, &mut columns, &mut slot_preds));
        }
    }
    ColumnLayout {
        columns: order(columns, &slot_preds),
        routes,
    }
}

/// Vertical lanes, git-log style (`TaskGraphLanes` of the layout lib).
#[derive(Clone, Debug)]
pub struct LaneLayout {
    /// Tasks top to bottom (rank, then column order): also the keyboard order.
    pub rows: Vec<SharedString>,
    pub lane: HashMap<SharedString, usize>,
    /// The lane each edge travels in between its rows.
    pub edge_lane: HashMap<SharedString, usize>,
    pub lane_count: usize,
}

fn free_lane(open: &mut Vec<Option<SharedString>>, skip: Option<usize>) -> usize {
    let found = open
        .iter()
        .enumerate()
        .position(|(i, slot)| slot.is_none() && Some(i) != skip);
    found.unwrap_or_else(|| {
        open.push(None);
        open.len() - 1
    })
}

/// `laneTaskGraph`: a lane stays reserved while its edge is open.
pub fn layout_lanes(columns: &ColumnLayout, index: &TaskGraphIndex) -> LaneLayout {
    let rows: Vec<SharedString> = columns
        .columns
        .iter()
        .flatten()
        .filter_map(|slot| match slot {
            TaskGraphSlot::Node(id) => Some(id.clone()),
            TaskGraphSlot::Dummy(_) => None,
        })
        .collect();
    let order: HashMap<&SharedString, usize> =
        rows.iter().enumerate().map(|(i, id)| (id, i)).collect();
    let mut open: Vec<Option<SharedString>> = Vec::new();
    let mut lane = HashMap::new();
    let mut edge_lane = HashMap::new();
    for id in &rows {
        let incoming: Vec<usize> = open
            .iter()
            .enumerate()
            .filter(|(_, slot)| slot.as_ref() == Some(id))
            .map(|(i, _)| i)
            .collect();
        let mine = incoming
            .iter()
            .copied()
            .min()
            .unwrap_or_else(|| free_lane(&mut open, None));
        for &i in &incoming {
            open[i] = None;
        }
        lane.insert(id.clone(), mine);
        let mut targets = index.succs_of(id).to_vec();
        targets.sort_by_key(|to| order.get(to).copied());
        for (j, to) in targets.iter().enumerate() {
            let at = if j == 0 && open[mine].is_none() {
                mine
            } else {
                free_lane(&mut open, Some(mine))
            };
            open[at] = Some(to.clone());
            edge_lane.insert(edge_key(id, to), at);
        }
    }
    LaneLayout {
        rows,
        lane,
        edge_lane,
        lane_count: open.len().max(1),
    }
}

/// How an edge reads (`TaskGraphEdgeState`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EdgeState {
    Satisfied,
    Waiting,
    Failed,
    Active,
}

/// Solid once the prerequisite is done; failed or cancelled sources break; a satisfied edge into
/// a running task is active.
pub fn edge_state(from: TaskGraphStatus, to: TaskGraphStatus) -> EdgeState {
    use TaskGraphStatus as S;
    match (from, to) {
        (S::Failed | S::Cancelled, _) => EdgeState::Failed,
        (S::Done, S::Running) => EdgeState::Active,
        (S::Done, _) => EdgeState::Satisfied,
        _ => EdgeState::Waiting,
    }
}

/// One state for a whole graph (section rows): running > failed > waiting > done > cancelled.
pub fn rollup_status(statuses: &[TaskGraphStatus]) -> TaskGraphStatus {
    use TaskGraphStatus as S;
    let has = |status| statuses.contains(&status);
    if has(S::Running) || has(S::Review) {
        S::Running
    } else if has(S::Failed) || has(S::Blocked) {
        S::Failed
    } else if statuses.iter().all(|&status| status == S::Done) {
        S::Done
    } else if has(S::Pending) || has(S::Paused) {
        S::Pending
    } else {
        S::Cancelled
    }
}

/// Everything the views derive from one graph revision.
#[derive(Debug)]
pub struct GraphShape {
    pub index: TaskGraphIndex,
    pub columns: ColumnLayout,
    pub lanes: LaneLayout,
}

impl GraphShape {
    pub fn new(ids: &[SharedString], edges: &[TaskGraphEdge]) -> Self {
        let index = TaskGraphIndex::new(ids, edges);
        let columns = layout_columns(&index);
        let lanes = layout_lanes(&columns, &index);
        Self {
            index,
            columns,
            lanes,
        }
    }

    /// The task ids in reading order, which is also the tab order of their cards.
    pub fn order(&self) -> &[SharedString] {
        &self.lanes.rows
    }
}

type Revision = (Vec<SharedString>, Vec<TaskGraphEdge>);

/// The shape of the graph `ids`/`edges`, recomputed only when they change: the view re-renders
/// every frame a spinner turns, the layout does not.
pub(crate) fn cached_shape(
    id: impl Into<ElementId>,
    ids: &[SharedString],
    edges: &[TaskGraphEdge],
    window: &mut Window,
    cx: &mut App,
) -> Rc<GraphShape> {
    let state = window.use_keyed_state(id, cx, |_, _| None::<(Revision, Rc<GraphShape>)>);
    if let Some(((seen_ids, seen_edges), shape)) = state.read(cx)
        && seen_ids == ids
        && seen_edges == edges
    {
        return shape.clone();
    }
    let shape = Rc::new(GraphShape::new(ids, edges));
    let next = ((ids.to_vec(), edges.to_vec()), shape.clone());
    state.update(cx, |cached, _| *cached = Some(next));
    shape
}
