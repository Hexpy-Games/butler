//! `browser/LibraryAttachDialog.tsx`: attaches saved items to a conversation the owner picks.
use gpui::{IntoElement as _, ParentElement as _};
use std::rc::Rc;

use butler_ds::ui::blocks::dialog_form::DialogForm;
use butler_ds::ui::blocks::empty_line::EmptyLine;
use butler_ds::ui::button::{Button, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::scroll::{MaxHeight, ScrollArea};
use gpui::{AnyElement, App, SharedString, Window};
use serde_json::{Value, json};

use super::copy::{Words, words};
use super::dialogs::{shell, text_field};
use crate::ui::manage::library::types::{LibraryItem, LibraryItemKind};
use crate::ui::manage::{Action, ManageCtx};
use crate::ui::source::wire::{NavigationView, SessionSummary};

#[derive(Default)]
struct Search {
    query: SharedString,
}

/// `LibraryAttachDialog`: the conversations (chats, then each project's) matching the search.
pub(crate) fn attach_dialog(
    ctx: &ManageCtx,
    items: &[LibraryItem],
    on_close: Action,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let copy = words(Ds::get(cx).lang());
    let search = window.use_keyed_state("library-attach-search", cx, |_, _| Search::default());
    let query = search.read(cx).query.clone();
    let input = text_field("library-attach-query", &query, usize::MAX, window, cx, {
        let search = search.clone();
        move |text, cx| {
            search.update(cx, |search, cx| {
                search.query = text;
                cx.notify();
            });
        }
    });
    let sessions = sessions(ctx.navigation(cx).as_deref(), &query);
    let close: Action = {
        let (search, on_close) = (search, on_close);
        Rc::new(move |window, cx| {
            search.update(cx, |search, _| search.query = SharedString::default());
            on_close(window, cx);
        })
    };
    let mut rows: Vec<AnyElement> = Vec::new();
    for (id, title) in sessions {
        let (ctx, items, close) = (ctx.clone(), items.to_vec(), close.clone());
        let session = id.clone();
        rows.push(
            Button::new(SharedString::from(format!("library-attach-{id}")))
                .variant(Variant::Ghost)
                .text(title)
                .on_click(move |_, window, cx| {
                    for item in &items {
                        ctx.attach_library(session.clone(), Rc::new(reference(item, copy)), cx);
                    }
                    close(window, cx);
                })
                .into_any_element(),
        );
    }
    if rows.is_empty() {
        rows.push(EmptyLine::new(copy.empty_library).into_any_element());
    }
    let list = ScrollArea::new("library-attach-scroll")
        .max_height(MaxHeight::Sm)
        .child(Stack::new().gap(Space::Xs).children(rows));
    let form = DialogForm::new(copy.attach_to_chat)
        .child(input)
        .child(list);
    shell(
        "library-attach-dialog",
        form,
        false,
        move |window, cx| close(window, cx),
        window,
        cx,
    )
}

/// `projectSpace(navigation)` rows that are sessions, whose title contains `query`.
fn sessions(navigation: Option<&NavigationView>, query: &str) -> Vec<(SharedString, SharedString)> {
    let Some(navigation) = navigation else {
        return Vec::new();
    };
    let title = |session: &SessionSummary| {
        if session.title.is_empty() {
            session.session_hint.clone()
        } else {
            session.title.clone()
        }
    };
    let wanted = query.to_lowercase();
    let projects = navigation
        .projects
        .iter()
        .flat_map(|project| project.sessions.iter().flatten());
    navigation
        .chats
        .iter()
        .chain(projects)
        .map(|session| (session.id.clone(), title(session)))
        .filter(|(_, title)| title.to_lowercase().contains(&wanted))
        .map(|(id, title)| (id.into(), title.into()))
        .collect()
}

/// The `library` reference a conversation keeps of an item (`attachLibraryReference`).
// F3: React also uploads the item's file (or its page data) first and keeps it on the reference;
// the composer's `library` reference kind and that upload are the frame's.
pub(super) fn reference(item: &LibraryItem, copy: &Words) -> Value {
    let site = item.site.clone().unwrap_or_else(|| {
        let label = match item.kind {
            LibraryItemKind::Output => 0,
            LibraryItemKind::Document | LibraryItemKind::Doc => 1,
            _ => 2,
        };
        copy.site_labels[label].to_owned()
    });
    json!({ "kind": "library", "id": item.id, "title": item.title, "site": site })
}
