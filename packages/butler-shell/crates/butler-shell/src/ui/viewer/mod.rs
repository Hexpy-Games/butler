//! The file viewer (non-HTML modes): `FileViewerPane`, `FileViewerFrame`, `FileViewerToggle`,
//! `useRightSlot`, in the AdaptiveShell split pane with tabs on TabStrip.
mod artifact;
pub(crate) mod frame;
mod state;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::adaptive_shell::parts::ShellCard;
use butler_ds::ui::blocks::tab_strip::{Group, GroupKind, Tab, TabStrip, TabStripLabels};
use butler_ds::ui::icon_button::{IconButton, Pane, Tone};
use butler_ds::ui::layout::{Box, Space, Stack};
use butler_ds::ui::presence::{Presence, PresenceMotion};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

pub(crate) use state::{
    FileViewerEntry, RightSlotPane, activate, close, open, right_slot_pane, session_files,
    set_shown,
};

use crate::ui::i18n::file_viewer::FileViewerStrings;

/// The viewer pane of a conversation; `None` while it is hidden or has no files. One tab per
/// open file (from two files on), then the file with its one title row. Closing the last file
/// empties the viewer, which frees the slot.
pub(crate) fn file_viewer_pane(
    session: &str,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let files = session_files(cx, session);
    if !files.shown {
        return None;
    }
    let active = files
        .entries
        .iter()
        .find(|entry| Some(entry.id()) == files.active_id.as_deref())
        .or(files.entries.first())?
        .clone();
    let c = FileViewerStrings::get(cx);
    let mut column = Stack::new().fill().gap(Space::None);
    if files.entries.len() > 1 {
        let tabs = files.entries.iter().map(|entry| {
            Tab::new(entry.id().to_owned(), entry_title(entry)).icon(entry_icon(entry))
        });
        let (activate_session, close_session) = (session.to_owned(), session.to_owned());
        let strip = TabStrip::new(
            "file-viewer-tabs",
            vec![Group::new("files", GroupKind::Mine).label(c.files).tabs(tabs)],
        )
        .active(Some(active.id().to_owned().into()))
        .labels(TabStripLabels {
            my_tabs: c.files.into(),
            close_tab: c.close_file.into(),
            ..TabStripLabels::default()
        })
        .hide_chip()
        .on_activate(move |id, _, cx| activate(cx, &activate_session, id))
        .on_close(move |id, _, cx| close(cx, &close_session, id));
        column = column.child(
            Box::new()
                .padding_x(Space::Sm)
                .padding_y(Space::Xs)
                .child(strip),
        );
    }
    column = column.child(artifact::artifact_viewer(session, &active, window, cx));
    Some(
        ShellCard::new()
            .child(
                Presence::new("file-viewer", true)
                    .motion(PresenceMotion::Fade)
                    .child(column),
            )
            .into_any_element(),
    )
}

fn entry_title(entry: &FileViewerEntry) -> String {
    match entry {
        FileViewerEntry::Artifact { artifact, .. } => artifact.title.clone(),
        FileViewerEntry::Document { title, .. } => title.clone(),
    }
}

fn entry_icon(entry: &FileViewerEntry) -> Icon {
    match entry {
        FileViewerEntry::Artifact { artifact, .. } if artifact::is_image_artifact(artifact) => Icon::ImageIcon,
        _ => Icon::FileText,
    }
}

/// `FileViewerToggle` ("파일 보기"): shown while the conversation has open files, pressed while
/// the viewer holds the right slot. Pressing it hides the viewer (the files stay open) or brings
/// it back in front of the browser. `browser` is the browser's raise stamp while it wants the slot.
pub(crate) fn file_viewer_toggle(
    session: &str,
    browser: Option<u64>,
    cx: &App,
) -> Option<AnyElement> {
    let files = session_files(cx, session);
    if files.entries.is_empty() {
        return None;
    }
    let shown = right_slot_pane(browser, &files) == Some(RightSlotPane::Viewer);
    let session = session.to_owned();
    Some(
        IconButton::new("titlebar-file-viewer-toggle", FileViewerStrings::get(cx).title)
            .glyph(Icon::FileText)
            .pane(Pane::Viewer)
            .pressed(shown)
            .tone(if shown { Tone::Butler } else { Tone::Default })
            .on_click(move |_, _, cx| set_shown(cx, &session, !shown))
            .into_any_element(),
    )
}
