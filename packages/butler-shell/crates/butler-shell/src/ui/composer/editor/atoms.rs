//! Atom chip rendering inside the editor (`ProjectReferenceNode`, `SessionReferenceNode`,
//! `ProjectSourceNode`). The chip is the DS `InlineReference`; an atom's text content is
//! `@label` (`getTextContent`).
use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::inline_reference::InlineReference;
use gpui::{App, ElementId, SharedString, Window};

use super::Atom;
use crate::ui::source::wire::{NavigationView, SpaceNodeKind};

/// The text an atom stands for in plain text (`getTextContent`).
pub(crate) fn atom_text(atom: &Atom) -> String {
    let (Atom::Project { label, .. }
    | Atom::Session { label, .. }
    | Atom::ProjectSource { label, .. }) = atom;
    format!("@{label}")
}

/// `sessionDisplayTitle`: the general channel has a localized identity, other chats their title.
pub(crate) fn session_display_title(id: &str, title: &str, general: &str) -> SharedString {
    if id == "general" {
        SharedString::from(general.to_owned())
    } else {
        SharedString::from(title.to_owned())
    }
}

/// Opens a project's dashboard (`openProjectDashboard`).
pub(crate) type OpenProject = Rc<dyn Fn(&str, &mut Window, &mut App)>;

/// The chip for `atom`; without the navigation yet, every reference reads as available. A deleted or archived project, or a session the space no longer lists
/// (except `general`), reads as unavailable. In a sent message (`open` given) a known project
/// chip opens the project.
pub(crate) fn atom_chip(
    id: impl Into<ElementId>,
    atom: &Atom,
    navigation: Option<&NavigationView>,
    general: &str,
    open: Option<OpenProject>,
) -> InlineReference {
    match atom {
        Atom::Project {
            id: project_id,
            label,
        } => {
            let known = navigation.is_none_or(|navigation| {
                navigation
                    .projects
                    .iter()
                    .any(|project| project.id == *project_id && !project.archived)
            });
            let mut chip = InlineReference::mention(id, Icon::Briefcase, label.clone());
            if !known {
                chip = chip.unavailable();
            }
            match open {
                Some(open) if known => {
                    let project_id = project_id.clone();
                    chip.on_click(move |_, window, cx| open(&project_id, window, cx))
                }
                _ => chip,
            }
        }
        Atom::Session {
            id: session_id,
            label,
        } => {
            let node = navigation.and_then(|navigation| {
                navigation.space.nodes.iter().find(|node| {
                    node.kind == SpaceNodeKind::Session && node.entityId == *session_id
                })
            });
            let icon = if node.is_some_and(|node| node.scopeProjectId.is_some()) {
                Icon::Notebook
            } else {
                Icon::MessageSquare
            };
            let chip = InlineReference::mention(
                id,
                icon,
                session_display_title(session_id, label, general),
            );
            if navigation.is_some() && node.is_none() && session_id != "general" {
                chip.unavailable()
            } else {
                chip
            }
        }
        Atom::ProjectSource { label, .. } => {
            InlineReference::mention(id, Icon::FileText, label.clone())
        }
    }
}
