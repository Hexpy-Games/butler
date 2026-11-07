//! Cached space projection, shared by every sidebar row (app/space/projection.ts).
mod live;
mod projection;
use crate::ui::source::wire::{
    NavigationView, ProjectSummary, SessionSummary, SpaceNode, WorkStatusView,
};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Clone)]
pub(crate) struct SpaceRowData {
    pub(crate) node: SpaceNode,
    pub(crate) title: String,
    pub(crate) session: Option<SessionSummary>,
    pub(crate) project: Option<ProjectSummary>,
    pub(crate) pinned: bool,
    #[expect(
        dead_code,
        reason = "SpaceRowData mirrors the React projection, including group origin"
    )]
    pub(crate) smart: bool,
    pub(crate) location: String,
    pub(crate) updated_at: String,
    pub(crate) ancestors: Vec<String>,
}

#[derive(Default)]
pub(crate) struct NavigationModel {
    pub(crate) view: Option<NavigationView>,
    pub(crate) rows: BTreeMap<String, SpaceRowData>,
    pub(crate) drag_rows: std::rc::Rc<BTreeMap<String, SpaceRowData>>,
    pub(crate) drag_children: std::rc::Rc<HashMap<Option<String>, Vec<String>>>,
    pub(crate) row_order: Vec<String>,
    pub(crate) space_label: String,
    pub(crate) general_label: String,
    pub(crate) children: HashMap<Option<String>, Vec<String>>,
    pub(crate) work_status: Option<WorkStatusView>,
    pub(crate) unread_ancestors: HashSet<String>,
    pub(crate) generation: u64,
    pub(crate) in_flight: bool,
    pub(crate) dirty: bool,
    pub(crate) retry_pending: bool,
}

impl NavigationModel {
    pub(crate) fn replace(&mut self, view: NavigationView) {
        self.view = Some(view);
        self.project_space();
    }
    pub(crate) fn active_parent_changed(&self, next: &NavigationView, id: &str) -> bool {
        let active = next.space.nodes.iter().find(|node| node.entityId == id);
        let before = self
            .view
            .as_ref()
            .and_then(|view| view.space.nodes.iter().find(|node| node.entityId == id));
        active.is_some_and(|node| before.is_none_or(|old| old.parentKey != node.parentKey))
    }
    pub(crate) fn rows(&self) -> Vec<SpaceRowData> {
        self.row_order
            .iter()
            .filter_map(|key| self.rows.get(key).cloned())
            .collect()
    }
    pub(crate) fn unread_ancestors(&self) -> &HashSet<String> {
        &self.unread_ancestors
    }
    pub(crate) fn is_route_active(id: &str, active: Option<&str>) -> bool {
        active == Some(id)
    }
    pub(crate) fn revision(&self) -> i64 {
        self.view.as_ref().map_or(0, |v| v.space.revision)
    }
    pub(crate) fn unread(&self, id: &str, attended: bool, active: Option<&str>) -> bool {
        self.rows
            .get(&format!("s:{id}"))
            .and_then(|r| r.session.as_ref())
            .is_some_and(|s| s.unread && !(attended && active == Some(id)))
    }
    pub(crate) fn children(&self, parent: Option<&str>) -> Vec<SpaceRowData> {
        self.children
            .get(&parent.map(str::to_owned))
            .into_iter()
            .flatten()
            .filter_map(|k| self.rows.get(k).cloned())
            .collect()
    }
}

pub(crate) fn space_activity(session: &SessionSummary, nested: bool) -> Option<&'static str> {
    use crate::ui::source::wire::TurnState::{
        Accepted, Cancelling, Failed, Queued, Retrying, RuntimeFault, SessionStarting, Streaming,
        Thinking, WaitingForForm, WaitingForTool,
    };
    let delegated = nested && session.attention_source.as_deref() == Some("subtask");
    if (session.attention_required && !delegated)
        || session.active_turn_state == Some(WaitingForForm)
    {
        return Some("attention");
    }
    if session.running_delegated_work || delegated {
        return Some("working");
    }
    match session.active_turn_state {
        Some(WaitingForForm | RuntimeFault | Failed) => Some("attention"),
        Some(
            Queued | Accepted | Thinking | Streaming | WaitingForTool | Cancelling | Retrying
            | SessionStarting,
        ) => Some("working"),
        _ => None,
    }
}
