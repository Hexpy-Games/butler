//! `MessageChangedFiles`, `MessageChangedFileRow`, `MessageGeneratedFileRow` and
//! `WorkingFileMenu`: the files a turn changed or made, each as a row with its ⋯ menu.
use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::changed_line_diff::{ChangedLineDiff, DiffLine, LineType};
use butler_ds::ui::blocks::disclosure_row::{DisclosureRow, Surface};
use butler_ds::ui::blocks::list_row::ListRow;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::dropdown_menu::{DropdownMenu, DropdownMenuContent, Item};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Cross, Inline, MinWidth, Space, Stack, StackItem, WithItem as _};
use butler_ds::ui::overlay::place::Align;
use butler_ds::ui::typo::Typo;
use gpui::{
    AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Styled as _, Window, div,
};

use super::media::{ViewerSet, WorkingRow, format_size, working_file_rows};
use super::support::{add_to_library, save_file};
use crate::ui::chat::message_markdown::inline_image_files;
use crate::ui::i18n::media::Media;
use crate::ui::shell::image_viewer::loader::PictureId;
use crate::ui::shell::image_viewer::{self, ViewerEntry};
use crate::ui::source::wire::{
    ChangedFileDetail, ChangedFileLine, ChangedFileLineType, MessageFileKind, MessageFileRef,
    MessageRecord,
};

const INITIAL_VISIBLE_FILES: usize = 5;

/// `MessageChangedFiles`: the changed-files block of an assistant message.
pub(super) fn changed_files(
    msg: &MessageRecord,
    set: &Rc<ViewerSet>,
    bubble: bool,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let files = msg.changed_files.as_deref().unwrap_or_default();
    let attachments = msg.attachments.as_deref().unwrap_or_default();
    let rows = working_file_rows(files, attachments, || {
        inline_image_files(&msg.text, attachments)
    });
    if rows.is_empty() {
        return None;
    }
    let expanded = window.use_keyed_state(
        SharedString::from(format!("changed-files-{}", msg.id)),
        cx,
        |_, _| false,
    );
    let open = *expanded.read(cx);
    let additions: i64 = files.iter().map(|file| file.additions).sum();
    let deletions: i64 = files.iter().map(|file| file.deletions).sum();
    let lang = Ds::get(cx).lang();
    let title = Media::file_changes(lang, rows.len(), additions, deletions);
    let shown = if open {
        rows.len()
    } else {
        rows.len().min(INITIAL_VISIBLE_FILES)
    };
    let mut column = Stack::new().gap(Space::Xs).child(Typo::label(title));
    for row in rows.iter().take(shown) {
        column = column.child(file_row(row, msg, set, window, cx));
    }
    if rows.len() > INITIAL_VISIBLE_FILES {
        let remaining = rows.len() - INITIAL_VISIBLE_FILES;
        let label = Media::files_toggle(lang, open, remaining);
        column = column.child(
            Button::new(SharedString::from(format!(
                "toggle-changed-files-{}",
                msg.id
            )))
            .variant(Variant::Ghost)
            .size(Size::Sm)
            .text(label)
            .on_click(move |_, _, cx| {
                expanded.update(cx, |open, cx| {
                    *open = !*open;
                    cx.notify();
                });
            }),
        );
    }
    let spacer = (!bubble).then(|| div().h(Space::Md.px(Ds::get(cx))));
    Some(
        div()
            .flex()
            .flex_col()
            .children(spacer)
            .child(column)
            .into_any_element(),
    )
}

fn file_row(
    row: &WorkingRow,
    msg: &MessageRecord,
    set: &Rc<ViewerSet>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    match (row.change, row.file) {
        (Some(change), stored) => change_row(change, stored, msg, set, window, cx),
        (None, Some(file)) => generated_row(file, msg, set, window, cx),
        (None, None) => div().into_any_element(),
    }
}

fn diff_lines(lines: &[ChangedFileLine]) -> Vec<DiffLine> {
    lines
        .iter()
        .filter_map(|line| {
            let kind = match line.r#type {
                ChangedFileLineType::Added => LineType::Added,
                ChangedFileLineType::Deleted => LineType::Deleted,
                ChangedFileLineType::Unknown => return None,
            };
            let mut out = DiffLine::new(kind, line.content.clone());
            if let Some(old) = line.old_line.and_then(|n| u32::try_from(n).ok()) {
                out = out.old_line(old);
            }
            if let Some(new) = line.new_line.and_then(|n| u32::try_from(n).ok()) {
                out = out.new_line(new);
            }
            Some(out)
        })
        .collect()
}

/// `MessageChangedFileRow`: a diff row; the ⋯ stays at the row header while the diff opens.
fn change_row(
    change: &ChangedFileDetail,
    stored: Option<&MessageFileRef>,
    msg: &MessageRecord,
    set: &Rc<ViewerSet>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let has_lines = !change.lines.is_empty();
    let meta: SharedString = if has_lines {
        format!("+{} −{}", change.additions, change.deletions).into()
    } else {
        Media::get(cx).no_line_details.into()
    };
    let key = format!("{}-{}", msg.id, change.path);
    let state = window.use_keyed_state(
        SharedString::from(format!("changed-row-{key}")),
        cx,
        |_, _| false,
    );
    let expanded = *state.read(cx);
    let glyph = icon(Icon::FileText, IconSize::Lg, Ds::get(cx));
    let body = if has_lines {
        let diff = ChangedLineDiff::new(
            SharedString::from(format!("changed-diff-{key}")),
            diff_lines(&change.lines),
        );
        DisclosureRow::new(
            SharedString::from(format!("changed-disclosure-{key}")),
            change.path.clone(),
        )
        .icon(glyph)
        .meta(meta)
        .open(expanded)
        .surface(Surface::Plain)
        .on_toggle(move |_, _, cx| {
            state.update(cx, |open, cx| {
                *open = !*open;
                cx.notify();
            });
        })
        .child(diff)
        .into_any_element()
    } else {
        ListRow::new(change.path.clone())
            .icon(glyph)
            .meta(meta)
            .into_any_element()
    };
    let Some(file) = stored else { return body };
    let menu = working_file_menu(file, &change.path, &msg.id, set, window, cx);
    Inline::new()
        .wrap(false)
        .gap(Space::Xs)
        .cross(if expanded {
            Cross::Start
        } else {
            Cross::Center
        })
        .child(
            StackItem::new()
                .grow()
                .min_width(MinWidth::Zero)
                .child(body),
        )
        .child(menu)
        .into_any_element()
}

/// `MessageGeneratedFileRow`: a file the turn made that has no line diff, plus its ⋯.
fn generated_row(
    file: &MessageFileRef,
    msg: &MessageRecord,
    set: &Rc<ViewerSet>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let title = file
        .source_label
        .clone()
        .unwrap_or_else(|| file.safe_name.clone());
    let size = format_size(file.size_bytes, false);
    let meta = Media::new_file(Ds::get(cx).lang(), &size);
    let glyph = icon(Icon::FileText, IconSize::Lg, Ds::get(cx));
    let row = ListRow::new(title.clone()).icon(glyph).meta(meta);
    let menu = working_file_menu(file, &title, &msg.id, set, window, cx);
    Inline::new()
        .wrap(false)
        .gap(Space::Xs)
        .child(StackItem::new().grow().min_width(MinWidth::Zero).child(row))
        .child(menu)
        .into_any_element()
}

/// `WorkingFileMenu`: ⋯ beside a row that has a stored copy: open, save, save to the Library.
fn working_file_menu(
    file: &MessageFileRef,
    title: &str,
    msg_id: &str,
    set: &Rc<ViewerSet>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let key = format!("{msg_id}-{}", file.file_id);
    let copy = Media::get(cx);
    let menu = DropdownMenu::new(
        SharedString::from(format!("working-file-menu-{key}")),
        window,
        cx,
    );
    let mut content = DropdownMenuContent::new().align(Align::End);
    if file.kind == MessageFileKind::Image {
        let (set, url) = (set.clone(), file.url.clone());
        let alone = ViewerEntry::new(
            PictureId::File(file.file_id.clone()),
            file.safe_name.clone(),
        );
        content = content.child(
            Item::new(copy.open)
                .icon(Icon::Popup)
                .on_select(move |_, cx| match set.index_of(&url) {
                    Some(index) => image_viewer::open(set.images.clone(), index, cx),
                    None => image_viewer::open(vec![alone.clone()], 0, cx),
                }),
        );
    }
    let (id, name) = (file.file_id.clone(), file.safe_name.clone());
    content = content.child(
        Item::new(copy.save)
            .icon(Icon::Save)
            .on_select(move |_, cx| save_file(id.clone(), name.clone(), cx)),
    );
    let id = file.file_id.clone();
    content = content.child(
        Item::new(copy.save_to_library)
            .icon(Icon::Library)
            .on_select(move |_, cx| add_to_library(id.clone(), cx)),
    );
    let label = format!("{}: {title}", copy.more);
    let trigger_id = SharedString::from(format!("working-file-trigger-{key}"));
    let trigger = menu.trigger(|toggle| {
        IconButton::new(trigger_id, label)
            .glyph(Icon::MoreHorizontal)
            .menu_trigger()
            .on_click(toggle.on_click())
            .into_any_element()
    });
    let content = menu.content(content, window, cx);
    div()
        .flex()
        .child(trigger)
        .child(content)
        .into_any_element()
}
