//! app/canonSidebarState.ts: build the conversation index when a sidebar read finishes.
use super::SidebarState;
use crate::ui::source::wire::{CanonSidebar, EpicCard};
impl SidebarState {
    pub(super) fn remember_sidebar(&mut self, sidebar: CanonSidebar) {
        for matches in self.canon_sessions.values_mut() {
            matches.retain(|epic| epic.project_id != sidebar.project_id);
        }
        self.canon_sessions.retain(|_, matches| !matches.is_empty());
        for epic in sidebar.groups.iter().flat_map(|g| &g.rows) {
            if let Some(session) = &epic.home_session_id {
                self.canon_sessions
                    .entry(session.clone())
                    .or_default()
                    .push(epic.clone());
            }
        }
        self.canon.insert(sidebar.project_id.clone(), sidebar);
    }
    pub(super) fn carries_session_state(&self, epic: &EpicCard) -> bool {
        let Some(shared) = epic
            .home_session_id
            .as_ref()
            .and_then(|id| self.canon_sessions.get(id))
        else {
            return true;
        };
        if shared.len() < 2 {
            return true;
        }
        let live: Vec<_> = shared
            .iter()
            .filter(|e| e.queue.as_ref().is_some_and(|q| q.state == "running"))
            .collect();
        if !live.is_empty() {
            return live.iter().any(|e| e.id == epic.id);
        }
        let finished = shared
            .iter()
            .filter(|e| e.queue.as_ref().is_some_and(|q| q.state == "done"))
            .max_by_key(|e| e.queue.as_ref().and_then(|q| q.finished_at).unwrap_or(0));
        if let Some(finished) = finished {
            return finished.id == epic.id;
        }
        let working: Vec<_> = shared.iter().filter(|e| e.running).collect();
        if working.is_empty() {
            shared.first().is_some_and(|e| e.id == epic.id)
        } else {
            working.iter().any(|e| e.id == epic.id)
        }
    }
}
