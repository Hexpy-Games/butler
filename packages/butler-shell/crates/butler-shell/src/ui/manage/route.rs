//! Where a view sits (`app/navigationBack.ts` `parentView`, `nestedTitle`; `app/utils.ts:1741`
//! `activeTitleForView`; `library/libraryNav.ts` `libraryParent`, `libraryTitle`): the titlebar
//! title, and the level its back button returns to.
#![allow(
    dead_code,
    reason = "seam API: the 서랍 units read it; F6 removes this"
)]
use butler_ds::ui::context::Lang;
use gpui::{App, SharedString};

use super::library::types::LibraryNames;
use super::{HistoryFrom, LibraryKind, LibraryView, View};
use crate::ui::i18n::manage::words;

/// One level up: another view, or a Settings section (the settings screen is not a [`View`]).
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Parent {
    View(View),
    Settings(&'static str),
}

/// `parentView`: the screen one level up from a nested one; top-level screens have none. The
/// browser (History's parent when opened there) is P5 (G-cef).
pub(crate) fn parent(view: &View) -> Option<Parent> {
    match view {
        View::History {
            from: HistoryFrom::Settings,
        } => Some(Parent::Settings("browser")),
        View::Library(library) => library_parent(library).map(|up| Parent::View(View::Library(up))),
        View::PlanOverview { project, .. } => Some(Parent::View(View::ProjectDashboard {
            project: project.clone(),
            epic: None,
        })),
        View::AutomationDetail(_) => Some(Parent::View(View::Automations)),
        View::Session
        | View::History {
            from: HistoryFrom::Browser,
        }
        | View::Automations
        | View::ProjectDashboard { .. } => None,
    }
}

/// `nestedTitle`: the title a parent shows in the back label; a Settings parent has none.
pub(crate) fn nested_title(parent: &Parent, lang: Lang, cx: &App) -> Option<SharedString> {
    let copy = words(lang);
    match parent {
        Parent::View(View::History { .. }) => Some(copy.history_title.into()),
        Parent::View(View::Library(library)) => Some(library_title(library, lang, cx)),
        Parent::View(View::Automations) => Some(copy.automations_title.into()),
        _ => None,
    }
}

/// `activeTitleForView`: the titlebar title of a management view; `None` keeps the chat's.
pub(crate) fn active_title(view: &View, lang: Lang) -> Option<&'static str> {
    let copy = words(lang);
    match view {
        View::Session => None,
        View::History { .. } => Some(copy.history_title),
        View::Library(_) => Some(copy.library),
        View::Automations | View::AutomationDetail(_) => Some(copy.automations_title),
        View::PlanOverview { .. } => Some(copy.canon_overview),
        View::ProjectDashboard { .. } => Some(copy.project_dashboard),
    }
}

/// `libraryParent`: item → its group (or kind) → kind → main; a document → the documents. The
/// main screen has none.
pub(crate) fn library_parent(view: &LibraryView) -> Option<LibraryView> {
    if view.doc.is_some() {
        return Some(LibraryView {
            section: Some(LibraryKind::Document),
            ..LibraryView::default()
        });
    }
    if view.item.is_some() {
        return Some(LibraryView {
            section: view.section,
            group: view.group.clone(),
            ..LibraryView::default()
        });
    }
    if view.group.is_some() {
        return Some(LibraryView {
            section: view.section,
            ..LibraryView::default()
        });
    }
    view.section.map(|_| LibraryView::default())
}

/// `libraryTitle`: the level's title (서랍 · 스크랩 · a group · the item), named from
/// [`LibraryNames`].
pub(crate) fn library_title(view: &LibraryView, lang: Lang, cx: &App) -> SharedString {
    let copy = words(lang);
    let names = cx.try_global::<LibraryNames>();
    if view.item.is_some() {
        return names
            .and_then(|names| names.item.as_ref())
            .map(|item| SharedString::from(item.title.clone()))
            .unwrap_or_else(|| copy.kind(view.section.unwrap_or(LibraryKind::Scrap)).into());
    }
    match (view.section, view.group.as_deref()) {
        (Some(LibraryKind::Bookmark), Some("none")) => copy.bookmark_ungrouped.into(),
        (Some(_), Some("none")) => copy.scrap_ungrouped.into(),
        (Some(section), Some(group)) => names
            .and_then(|names| names.groups.get(group))
            .map(|group| group.name.clone())
            .unwrap_or_else(|| copy.kind(section).into()),
        (Some(section), None) => format!("{} › {}", copy.library_title, copy.kind(section)).into(),
        (None, _) => copy.library_title.into(),
    }
}
