//! `SessionSections`, `useSessionSectionsModel`, `SessionSection`, `PendingAskRows`,
//! `SubtaskRows`, `SubtaskWorkerRows` and `SubtaskMark`.
//!
//! The same ordered sections on the flat margin and on floating glass. The visibility model
//! (`useSessionSectionsModel`) is the sections themselves: a section whose content is `None`
//! (or whose data is empty) is not built, so no floating separator is left behind. The open
//! session's view is the session summary here, so no section waits for a summary to load.
pub(crate) mod asks;
mod state;
mod subtasks;

use std::collections::HashSet;

use butler_ds::ui::blocks::attachment_list::{AttachmentItem, AttachmentList, TileLayout, Variant};
use butler_ds::ui::blocks::conversation_shell::AsideLayout;
use butler_ds::ui::blocks::disclosure_row::{DisclosureRow, Surface};
use butler_ds::ui::blocks::key_value_row::{KeyValueRow, ValueSize};
use butler_ds::ui::card::{Card, CardPadding};
use butler_ds::ui::layout::{Box as DsBox, Cross, Justify, Space, Stack};
use butler_ds::ui::separator::Separator;
use butler_ds::ui::typo::{Tone, Typo, Weight};
use gpui::{AnyElement, App, Entity, IntoElement as _, ParentElement as _, SharedString, Window};

use super::InspectorCtx;
use crate::ui::i18n::session_sections::SessionSections;
use crate::ui::source::wire::{
    CanonQueueItemState, MessageRecordRole, SessionPendingAsks, SessionView, SubtaskState,
};
pub(crate) use state::SessionSectionsState;

/// What `useSessionSectionsModel` reads besides the view: the pending asks and the number of
/// queue items not done (`notDone`). Data only; no section is built here.
struct Data {
    asks: Option<SessionPendingAsks>,
    not_done: i64,
}

fn data(ctx: &InspectorCtx<'_>, state: &Entity<SessionSectionsState>, cx: &mut App) -> Data {
    let view = ctx.view;
    let asks = state
        .read(cx)
        .asks(&view.session_id)
        .filter(|page| page.open_count > 0)
        .cloned();
    let queue = super::order::queue::snapshot(cx, &view.session_id);
    let not_done = queue
        .view
        .iter()
        .flat_map(|v| &v.chains)
        .flat_map(|c| &c.steps)
        .flat_map(|s| &s.items)
        .filter(|item| item.state != CanonQueueItemState::Done)
        .count();
    Data {
        asks,
        not_done: i64::try_from(not_done).unwrap_or(i64::MAX),
    }
}

/// What the titlebar's session actions and the sections read from the model.
pub(crate) struct SessionSectionsModel {
    data: Data,
    /// `ids.length > 0`
    pub(crate) has_ids: bool,
    /// An ask waits, or a subtask needs approval.
    pub(crate) indicator: bool,
}

/// `useSessionSectionsModel`, as far as the titlebar needs it. The browser and epic sections
/// have no data here yet (their entries are P5 and P4 stubs), so they do not count.
pub(crate) fn session_sections_model(
    ctx: &InspectorCtx<'_>,
    state: &Entity<SessionSectionsState>,
    cx: &mut App,
) -> SessionSectionsModel {
    let data = data(ctx, state, cx);
    let view = ctx.view;
    let has_ids = data.asks.is_some()
        || view.subtasks.as_ref().is_some_and(|s| !s.is_empty())
        || data.not_done > 0
        || environment_values(view).is_some()
        || view.context.is_some()
        || has_artifacts(view)
        || has_attachments(view)
        || !view.automations.is_empty();
    let indicator = data.asks.is_some()
        || view
            .subtasks
            .iter()
            .flatten()
            .any(|s| s.state == SubtaskState::NeedsApproval);
    SessionSectionsModel {
        data,
        has_ids,
        indicator,
    }
}

/// The session sections of the inspector.
pub(crate) fn session_sections(
    ctx: &InspectorCtx<'_>,
    model: &SessionSectionsModel,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let view = ctx.view;
    let copy = SessionSections::get(cx);
    let layout = ctx.layout;
    let mut sections: Vec<AnyElement> = Vec::new();
    let data = &model.data;

    if let Some(page) = data.asks.as_ref() {
        let rows = asks::pending_ask_rows(&page.asks, cx);
        sections.push(section(
            "asks",
            layout,
            Some(copy.asks),
            Some(page.open_count),
            rows,
        ));
    }
    let subtasks = view.subtasks.as_deref().unwrap_or_default();
    if !subtasks.is_empty() {
        let rows = subtasks::subtask_rows(&view.session_id, subtasks, window, cx);
        sections.push(section(
            "subtasks",
            layout,
            Some(copy.subtasks),
            i64::try_from(subtasks.len()).ok(),
            vec![rows],
        ));
    }
    if data.not_done > 0
        && let Some(order) = super::order::step_order_section(ctx, window, cx)
    {
        sections.push(section(
            "order",
            layout,
            Some(copy.order),
            Some(data.not_done),
            vec![order],
        ));
    }
    // The browser section wraps itself.
    sections.extend(super::session_misc::browser_section(ctx, window, cx));
    if let Some(environment) = environment(view, copy, layout) {
        sections.push(environment);
    }
    if let Some(epic) = super::order::epic_inspector(ctx, window, cx) {
        sections.push(section("task", layout, Some(copy.epic), None, vec![epic]));
    }
    if let Some(context) = view.context.as_ref() {
        sections.push(context_section(ctx, context.ratio, layout, window, cx));
    }
    if has_artifacts(view) {
        let panel = super::artifacts::artifacts_panel(ctx, true, window, cx);
        sections.push(section("artifacts", layout, None, None, vec![panel]));
    }
    let attachments = attachments(view);
    if !attachments.is_empty() {
        let count = i64::try_from(attachments.len()).ok();
        let tiles = attachment_tiles(&view.session_id, attachments);
        sections.push(section(
            "attachments",
            layout,
            Some(copy.attachments),
            count,
            vec![tiles],
        ));
    }
    if !view.automations.is_empty()
        && let Some(schedules) = super::artifacts::automation_targets_panel(ctx, true, window, cx)
    {
        sections.push(section("schedules", layout, None, None, vec![schedules]));
    }
    section_list(layout, sections)
}

/// `SessionSectionList`: a separator between sections on floating glass.
fn section_list(layout: AsideLayout, sections: Vec<AnyElement>) -> AnyElement {
    let mut items = Vec::with_capacity(sections.len() * 2);
    for (index, section) in sections.into_iter().enumerate() {
        if layout == AsideLayout::Floating && index > 0 {
            items.push(Separator::new().space(Space::None).into_any_element());
        }
        items.push(section);
    }
    Stack::new()
        .gap(Space::Md)
        .children(items)
        .into_any_element()
}

/// `SessionSection`: a card in the docked margin, a flat block on floating glass. Rows reach
/// into the inline inset by their bleed; the inset holds that hover fill and its focus ring.
fn section(
    id: &str,
    layout: AsideLayout,
    title: Option<&'static str>,
    count: Option<i64>,
    children: Vec<AnyElement>,
) -> AnyElement {
    let docked = layout == AsideLayout::Docked;
    let header = title.map(|title| section_header(title, count));
    let content = DsBox::new()
        .padding_x(if docked { Space::Lg } else { Space::Md })
        .padding_y(if docked { Space::Sm } else { Space::Md })
        .child(
            Stack::new()
                .gap(Space::Sm)
                .children(header)
                .children(children),
        );
    let id = SharedString::from(format!("session-section-{id}"));
    if docked {
        Card::new(id)
            .padding(CardPadding::None)
            .child(content)
            .into_any_element()
    } else {
        Stack::new()
            .gap(Space::Sm)
            .child(content)
            .into_any_element()
    }
}

/// `SessionSectionHeader`
fn section_header(title: &'static str, count: Option<i64>) -> AnyElement {
    Stack::row()
        .justify(Justify::Between)
        .cross(Cross::Center)
        .gap(Space::Sm)
        .child(
            Typo::caption(title)
                .tone(Tone::Secondary)
                .weight(Weight::Medium),
        )
        .children(count.map(|count| {
            Typo::caption(count.to_string())
                .tone(Tone::Secondary)
                .tabular()
        }))
        .into_any_element()
}

/// The working folder and the branch name, when the session has either.
fn environment_values(view: &SessionView) -> Option<(Option<String>, Option<String>)> {
    let branch = view.branch.as_ref();
    let named = |text: &Option<String>| text.clone().filter(|text| !text.is_empty());
    let folder =
        branch.and_then(|b| named(&b.workspace_path).or_else(|| named(&b.workspace_label)));
    let name = branch.and_then(|b| named(&b.branch_name));
    (folder.is_some() || name.is_some()).then_some((folder, name))
}

/// The environment section: the working folder and the branch.
fn environment(
    view: &SessionView,
    copy: &SessionSections,
    layout: AsideLayout,
) -> Option<AnyElement> {
    let (folder, name) = environment_values(view)?;
    let rows = [(copy.folder, folder), (copy.branch, name)]
        .into_iter()
        .filter_map(|(label, value)| {
            value.map(|value| {
                KeyValueRow::new(label, value)
                    .value_size(ValueSize::Caption)
                    .into_any_element()
            })
        })
        .collect();
    Some(section(
        "environment",
        layout,
        Some(copy.environment),
        None,
        rows,
    ))
}

/// The context section: a plain disclosure row with the used share, opening the compact usage.
fn context_section(
    ctx: &InspectorCtx<'_>,
    ratio: f64,
    layout: AsideLayout,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let copy = SessionSections::get(cx);
    let key = SharedString::from(format!("session-context-open-{}", ctx.view.session_id));
    let open = window.use_keyed_state(key, cx, |_, _| false);
    let is_open = *open.read(cx);
    let compact = super::session_misc::context_compact(ctx, window, cx);
    let row = DisclosureRow::new("session-context", copy.context)
        .surface(Surface::Plain)
        .meta(format!("{:.0}%", ratio * 100.0))
        .open(is_open)
        .on_toggle(move |_, window, cx| {
            open.update(cx, |open, _| *open = !*open);
            window.refresh();
        })
        .children(compact);
    section("context", layout, None, None, vec![row.into_any_element()])
}

/// `hasArtifacts`: `sessionArtifacts` is empty unless some artifact was delivered.
fn has_artifacts(view: &SessionView) -> bool {
    let from_messages = view
        .messages
        .iter()
        .flat_map(|m| m.artifacts.iter().flatten());
    view.artifacts
        .iter()
        .chain(from_messages)
        .any(|artifact| artifact.deliverable == Some(true))
}

/// `attachments.length > 0`, without building the list.
fn has_attachments(view: &SessionView) -> bool {
    view.messages
        .iter()
        .filter(|message| message.role == MessageRecordRole::User)
        .any(|message| message.attachments.iter().flatten().next().is_some())
}

/// The files the user attached, each file once (`attachments` of the sections model).
fn attachments(view: &SessionView) -> Vec<(String, String)> {
    let mut seen = HashSet::new();
    view.messages
        .iter()
        .filter(|message| message.role == MessageRecordRole::User)
        .flat_map(|message| message.attachments.iter().flatten())
        .filter(|file| seen.insert(file.file_id.clone()))
        .map(|file| (file.file_id.clone(), file.safe_name.clone()))
        .collect()
}

/// `MessageAttachments` as tiles. Thumbnails, sizes and opening a file are not carried: they
/// live in the transcript's private attachment code.
fn attachment_tiles(session_id: &str, files: Vec<(String, String)>) -> AnyElement {
    let items = files
        .into_iter()
        .map(|(id, name)| AttachmentItem::new(id, name))
        .collect();
    AttachmentList::new(
        SharedString::from(format!("session-attachments-{session_id}")),
        items,
    )
    .variant(Variant::Tiles)
    .tile_layout(TileLayout::Wrap)
    .into_any_element()
}
