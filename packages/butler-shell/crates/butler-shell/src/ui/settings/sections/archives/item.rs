//! `archiveSettingsUtils.ts` and `ArchiveItemRow.tsx`: the archive list's rows.
use std::rc::Rc;

use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Lang;
use butler_ds::ui::layout::{Cross, Justify, Space, Stack};
use butler_ds::ui::typo::{Tone, Typo};
use chrono::{DateTime, Utc};
use gpui::{
    AnyElement, App, ClickEvent, IntoElement as _, ParentElement as _, SharedString, Window,
};
use serde::Deserialize;

use super::copy::Words;
use crate::ui::i18n::Locale;

#[derive(Deserialize)]
pub(super) struct Project {
    id: String,
    display_name: String,
    last_activity_at: String,
}

#[derive(Deserialize)]
struct ProjectRef {
    display_name: String,
}

#[derive(Deserialize)]
pub(super) struct Session {
    id: String,
    kind: String,
    title: String,
    project_id: Option<String>,
    project: Option<ProjectRef>,
    last_activity_at: String,
}

#[derive(Deserialize)]
pub(super) struct Pagination {
    #[serde(default)]
    pub(super) has_more: bool,
}

/// `ArchiveListView`
#[derive(Deserialize)]
pub(super) struct ArchiveList {
    pub(super) projects: Vec<Project>,
    pub(super) sessions: Vec<Session>,
    pub(super) pagination: Pagination,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Project,
    Session,
}

/// `ArchiveItem`, with the subtitle already worded.
pub(super) struct Item {
    pub(super) kind: Kind,
    pub(super) id: String,
    pub(super) title: String,
    subtitle: String,
    updated_at: String,
}

/// `archiveItems`: projects and sessions, newest first.
pub(super) fn items(list: &ArchiveList, copy: &Words) -> Vec<Item> {
    let projects = list.projects.iter().map(|project| Item {
        kind: Kind::Project,
        id: project.id.clone(),
        title: project.display_name.clone(),
        subtitle: copy.project.to_owned(),
        updated_at: project.last_activity_at.clone(),
    });
    let sessions = list.sessions.iter().map(|session| Item {
        kind: Kind::Session,
        id: session.id.clone(),
        title: if session.id == "general" {
            copy.space_general.to_owned()
        } else {
            session.title.clone()
        },
        subtitle: subtitle(session, copy),
        updated_at: session.last_activity_at.clone(),
    });
    let mut items: Vec<Item> = projects.chain(sessions).collect();
    items.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    items
}

/// `archiveSubtitle` of a session.
fn subtitle(session: &Session, copy: &Words) -> String {
    if session.kind != "project" {
        return copy.general_conversation.to_owned();
    }
    let name = session
        .project
        .as_ref()
        .map(|project| project.display_name.as_str())
        .or(session.project_id.as_deref())
        .unwrap_or(copy.unknown_project);
    (copy.project_conversation)(name)
}

/// `relativeAge` of a timestamp; empty when it does not parse.
fn relative_age(since: &str, lang: Lang) -> String {
    let Ok(at) = DateTime::parse_from_rfc3339(since) else {
        return String::new();
    };
    let seconds = (Utc::now() - at.with_timezone(&Utc)).num_seconds().max(0);
    let locale = match lang {
        Lang::Ko => Locale::Ko,
        Lang::En => Locale::En,
    };
    locale.strings().relative_age(seconds)
}

pub(super) type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// `ArchiveItemRow`: `open` is given for sessions only.
pub(super) fn row(
    item: &Item,
    busy: bool,
    lang: Lang,
    copy: &Words,
    open: Option<Handler>,
    restore: Handler,
    remove: Handler,
) -> AnyElement {
    let kind = match item.kind {
        Kind::Project => "project",
        Kind::Session => "session",
    };
    let key = format!("{kind}-{}", item.id);
    let title = match open {
        Some(open) => Button::new(SharedString::from(format!("archive-open-{key}")))
            .variant(Variant::Link)
            .size(Size::Sm)
            .text(item.title.clone())
            .on_click(move |event, window, cx| open(event, window, cx))
            .into_any_element(),
        None => Typo::body(item.title.clone()).into_any_element(),
    };
    let age = relative_age(&item.updated_at, lang);
    let mut unarchive = Button::new(SharedString::from(format!("archive-restore-{key}")))
        .variant(Variant::Outline)
        .size(Size::Sm)
        .text(copy.unarchive)
        .on_click(move |event, window, cx| restore(event, window, cx));
    let mut delete = Button::new(SharedString::from(format!("archive-remove-{key}")))
        .variant(Variant::Destructive)
        .size(Size::Sm)
        .text(copy.delete)
        .on_click(move |event, window, cx| remove(event, window, cx));
    if busy {
        unarchive = unarchive.disabled();
        delete = delete.disabled();
    }
    Stack::row()
        .cross(Cross::Center)
        .justify(Justify::Between)
        .gap(Space::Md)
        .wrap(true)
        .child(
            Stack::new()
                .gap(Space::Xs)
                .child(title)
                .child(Typo::caption(format!("{} · {age}", item.subtitle)).tone(Tone::Secondary)),
        )
        .child(button::container(Size::Sm).child(unarchive).child(delete))
        .into_any_element()
}
