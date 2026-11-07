//! app/space/projection.ts: explicit ownership, hidden ancestors and child ordering.
use super::{NavigationModel, SpaceRowData};
use crate::ui::source::wire::{
    NavigationView, ProjectSummary, SessionSummary, SpaceGroup, SpaceGroupOrigin, SpaceNode,
    SpaceNodeKind,
};
use std::collections::HashMap;
struct Projection<'a> {
    space_label: &'a str,
    general_label: &'a str,
    sessions: HashMap<&'a str, &'a SessionSummary>,
    projects: HashMap<&'a str, &'a ProjectSummary>,
    groups: HashMap<&'a str, &'a SpaceGroup>,
    nodes: HashMap<&'a str, &'a SpaceNode>,
}
impl<'a> Projection<'a> {
    fn new(view: &'a NavigationView, space_label: &'a str, general_label: &'a str) -> Self {
        Self {
            space_label,
            general_label,
            sessions: view
                .chats
                .iter()
                .chain(
                    view.projects
                        .iter()
                        .flat_map(|p| p.sessions.iter().flatten()),
                )
                .map(|s| (s.id.as_str(), s))
                .collect(),
            projects: view.projects.iter().map(|p| (p.id.as_str(), p)).collect(),
            groups: view
                .space
                .groups
                .iter()
                .map(|g| (g.id.as_str(), g))
                .collect(),
            nodes: view
                .space
                .nodes
                .iter()
                .map(|n| (n.key.as_str(), n))
                .collect(),
        }
    }
    fn title(&self, node: &SpaceNode) -> Option<String> {
        if node.entityId == "general" {
            return Some(self.general_label.to_owned());
        }
        match node.kind {
            SpaceNodeKind::Session => self
                .sessions
                .get(node.entityId.as_str())
                .map(|s| s.title.clone()),
            SpaceNodeKind::Project => self
                .projects
                .get(node.entityId.as_str())
                .map(|p| p.display_name.clone()),
            _ => self
                .groups
                .get(node.entityId.as_str())
                .map(|g| g.title.clone()),
        }
    }
    fn row(&self, node: &SpaceNode) -> Option<SpaceRowData> {
        let session = self
            .sessions
            .get(node.entityId.as_str())
            .copied()
            .filter(|_| node.kind == SpaceNodeKind::Session);
        let project = self
            .projects
            .get(node.entityId.as_str())
            .copied()
            .filter(|_| node.kind == SpaceNodeKind::Project);
        let title = self.title(node).filter(|t| !t.is_empty())?;
        if session.is_some_and(|s| s.archived) || project.is_some_and(|p| p.archived) {
            return None;
        }
        let mut parent = node
            .parentKey
            .as_deref()
            .and_then(|k| self.nodes.get(k).copied());
        let (mut ancestors, mut path) = (Vec::new(), Vec::new());
        while let Some(p) = parent {
            if p.kind == SpaceNodeKind::Project
                && self
                    .projects
                    .get(p.entityId.as_str())
                    .is_some_and(|p| p.archived)
            {
                return None;
            }
            ancestors.insert(0, p.key.clone());
            path.insert(0, self.title(p).unwrap_or_default());
            parent = p
                .parentKey
                .as_deref()
                .and_then(|k| self.nodes.get(k).copied());
        }
        Some(SpaceRowData {
            node: node.clone(),
            title,
            session: session.cloned(),
            project: project.cloned(),
            pinned: session.map_or_else(|| project.is_some_and(|p| p.pinned), |s| s.pinned),
            smart: self
                .groups
                .get(node.entityId.as_str())
                .is_some_and(|g| g.origin == SpaceGroupOrigin::Smart),
            location: if path.is_empty() {
                self.space_label.to_owned()
            } else {
                path.join(" › ")
            },
            updated_at: session.map_or_else(
                || project.map_or(String::new(), |p| p.last_activity_at.clone()),
                |s| s.last_activity_at.clone(),
            ),
            ancestors,
        })
    }
    fn detached(&self, session: &SessionSummary) -> Option<SpaceRowData> {
        let project = session
            .project_id
            .as_deref()
            .and_then(|id| self.projects.get(id));
        if session.archived || project.is_some_and(|p| p.archived) {
            return None;
        }
        Some(SpaceRowData {
            node: SpaceNode {
                key: format!("s:{}", session.id),
                kind: SpaceNodeKind::Session,
                entityId: session.id.clone(),
                parentKey: None,
                position: 0,
                revision: 0,
                manualPlacement: false,
                scopeProjectId: session.project_id.clone(),
            },
            title: if session.id == "general" {
                self.general_label.to_owned()
            } else {
                session.title.clone()
            },
            session: Some(session.clone()),
            project: None,
            pinned: session.pinned && session.id != "general",
            smart: false,
            location: if session.id == "general" {
                self.general_label.to_owned()
            } else {
                project.map_or_else(|| self.space_label.to_owned(), |p| p.display_name.clone())
            },
            updated_at: session.last_activity_at.clone(),
            ancestors: Vec::new(),
        })
    }
}
impl NavigationModel {
    pub(super) fn project_space(&mut self) {
        self.rows.clear();
        self.row_order.clear();
        self.children.clear();
        self.unread_ancestors.clear();
        let Some(view) = &self.view else {
            return;
        };
        let index = Projection::new(view, &self.space_label, &self.general_label);
        if let Some(general) = index
            .sessions
            .get("general")
            .and_then(|s| index.detached(s))
        {
            self.row_order.push(general.node.key.clone());
            self.rows.insert(general.node.key.clone(), general);
        }
        for node in &view.space.nodes {
            let Some(row) = index.row(node) else {
                continue;
            };
            if node.key != "s:general" {
                self.children
                    .entry(node.parentKey.clone())
                    .or_default()
                    .push(node.key.clone());
                self.row_order.push(node.key.clone());
            }
            self.rows.insert(node.key.clone(), row);
        }
        for children in self.children.values_mut() {
            children.sort_by(|a, b| {
                self.rows[a]
                    .node
                    .position
                    .cmp(&self.rows[b].node.position)
                    .then(a.cmp(b))
            });
        }
        for session in view.chats.iter().chain(
            view.projects
                .iter()
                .flat_map(|p| p.sessions.iter().flatten()),
        ) {
            if self.rows.contains_key(&format!("s:{}", session.id)) {
                continue;
            }
            if let Some(row) = index.detached(session) {
                self.row_order.push(row.node.key.clone());
                self.rows.insert(row.node.key.clone(), row);
            }
        }
        self.drag_rows = std::rc::Rc::new(self.rows.clone());
        self.drag_children = std::rc::Rc::new(self.children.clone());
        for row in self.rows.values() {
            if row.session.as_ref().is_some_and(|s| s.unread) {
                self.unread_ancestors.extend(row.ancestors.iter().cloned());
            }
        }
    }
}
